const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const cron = require("node-cron");
const { config } = require("./config");
const { postNextFromQueue } = require("./pinterest-post-service");

function nowIso() {
  return new Date().toISOString();
}

function normalizeDailyTimes(times) {
  const source = Array.isArray(times) ? times : [];
  const normalized = source
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => {
      const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value);
      if (!match) {
        throw new Error(`Invalid time "${value}". Use HH:MM (24h).`);
      }
      return `${match[1].padStart(2, "0")}:${match[2]}`;
    });

  const uniqueSorted = Array.from(new Set(normalized)).sort((a, b) =>
    a.localeCompare(b)
  );
  if (!uniqueSorted.length) {
    throw new Error("Please provide at least one valid time.");
  }
  return uniqueSorted;
}

function getLocalTimeKey(date, timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(date);
}

class PinterestDaemonController {
  constructor(options = {}) {
    this.accountId = options.accountId || "default";
    this.queueDir = options.queueDir || config.pinterestQueueDir;
    this.postedDir = options.postedDir || config.pinterestPostedDir;
    this.failedDir = options.failedDir || config.pinterestFailedDir;

    this.task = null;
    this.isPosting = false;
    this.lastRunAt = null;
    this.lastResult = null;
    this.logs = [];
    this.cronExpression = config.pinterestCronExpression;
    this.schedulePlan = { type: "cron", expression: this.cronExpression };
    this.lastScheduleTriggerKey = null;
    this.instantPost = false;
    this._queueWatcher = null;
    this._watchDebounce = null;
    this._scheduledTimers = new Set();
    this.statePath = options.statePath || path.resolve(config.projectRoot, "pinterest-scheduler-state.json");
    this._loadState();
  }

  _loadState() {
    try {
      const data = fsSync.readFileSync(this.statePath, "utf-8");
      const state = JSON.parse(data);
      if (state.schedulePlan && state.schedulePlan.type === "daily-times") {
        this.schedulePlan = {
          type: "daily-times",
          times: normalizeDailyTimes(state.schedulePlan.times),
        };
      } else if (state.schedulePlan && state.schedulePlan.type === "cron") {
        this.cronExpression = state.schedulePlan.expression || this.cronExpression;
        this.schedulePlan = { type: "cron", expression: this.cronExpression };
      } else if (state.cronExpression) {
        this.cronExpression = state.cronExpression;
        this.schedulePlan = { type: "cron", expression: this.cronExpression };
      }
      if (typeof state.instantPost === "boolean") {
        this.instantPost = state.instantPost;
        if (this.instantPost) {
          this._startWatching();
        }
      }
    } catch (error) {
      // Ignore missing file or parse error
    }
  }

  async _saveState() {
    try {
      await fs.writeFile(
        this.statePath,
        JSON.stringify(
          {
            cronExpression: this.cronExpression,
            schedulePlan: this.schedulePlan,
            instantPost: this.instantPost,
          },
          null,
          2
        )
      );
    } catch (error) {
      this.log(`Failed to save scheduler state: ${error.message}`, "error");
    }
  }

  async setSchedule(expression) {
    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron expression: ${expression}`);
    }
    this.cronExpression = expression;
    this.schedulePlan = { type: "cron", expression };
    await this._saveState();
    this.log(`Schedule updated to: ${expression}`);
    if (this.task) {
      this.stop();
      this.start();
    }
    return { ok: true, cronExpression: this.cronExpression };
  }

  async setDailyTimes(times) {
    const normalizedTimes = normalizeDailyTimes(times);
    this.schedulePlan = { type: "daily-times", times: normalizedTimes };
    this.lastScheduleTriggerKey = null;
    await this._saveState();
    this.log(`Schedule updated to daily times: ${normalizedTimes.join(", ")}`);
    if (this.task) {
      this.stop();
      this.start();
    }
    return { ok: true, schedulePlan: this.schedulePlan };
  }

  log(message, level = "info") {
    const entry = { at: nowIso(), level, message };
    this.logs.unshift(entry);
    this.logs = this.logs.slice(0, 50);
    const prefix = `[${entry.at}] [pinterest:${this.accountId}]`;
    if (level === "error") {
      console.error(`${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  async runOnce(source = "manual") {
    if (this.isPosting) {
      return { ok: false, skipped: true, reason: "A Pinterest post is already in progress." };
    }

    this.isPosting = true;
    this.lastRunAt = nowIso();
    this.log(`Run triggered by ${source}.`);

    try {
      const result = await postNextFromQueue({
        source,
        queueDir: this.queueDir,
        postedDir: this.postedDir,
        failedDir: this.failedDir,
        accountId: this.accountId,
      });
      this.lastResult = result;

      if (result.skipped) {
        this.log(result.reason);
      } else if (result.ok) {
        this.log(`Posted successfully: ${result.movedMedia}`);
      } else {
        this.log(`Post failed: ${result.error}`, "error");
        if (result.screenshotPath) {
          this.log(`Screenshot: ${result.screenshotPath}`, "error");
        }
      }
      return result;
    } catch (error) {
      const failedResult = { ok: false, error: error.message || "Unexpected Pinterest scheduler error" };
      this.lastResult = failedResult;
      this.log(`Post failed: ${failedResult.error}`, "error");
      return failedResult;
    } finally {
      this.isPosting = false;
    }
  }

  _scheduleWithJitter(source) {
    const MAX_JITTER_MS = 10 * 60 * 1000;
    const jitterMs = Math.floor(Math.random() * MAX_JITTER_MS);
    const jitterMin = Math.round(jitterMs / 1000 / 60 * 10) / 10;
    this.log(`Scheduled post will fire in ~${jitterMin} min (jitter).`);
    const timer = setTimeout(() => {
      this._scheduledTimers.delete(timer);
      if (!this.task) {
        this.log("Scheduled post skipped because scheduler is stopped.");
        return;
      }
      this.runOnce(source);
    }, jitterMs);
    this._scheduledTimers.add(timer);
  }

  _clearScheduledTimers() {
    for (const timer of this._scheduledTimers) {
      clearTimeout(timer);
    }
    this._scheduledTimers.clear();
  }

  start() {
    if (this.task) {
      return { ok: true, alreadyRunning: true };
    }

    this._clearScheduledTimers();

    if (this.schedulePlan.type === "daily-times") {
      this._startDailyTimes();
    } else {
      this._startCron();
    }

    this.log("Scheduler started.");
    return { ok: true, alreadyRunning: false };
  }

  _startDailyTimes() {
    const times = this.schedulePlan.times || [];
    this.task = setInterval(() => {
      const now = new Date();
      const currentKey = getLocalTimeKey(now, config.timezone);

      if (times.includes(currentKey) && currentKey !== this.lastScheduleTriggerKey) {
        this.lastScheduleTriggerKey = currentKey;
        this.log(`Daily time match: ${currentKey}`);
        this._scheduleWithJitter("daily-time");
      }

      if (currentKey !== this.lastScheduleTriggerKey) {
        this.lastScheduleTriggerKey = null;
      }
    }, 30 * 1000);
  }

  _startCron() {
    this.task = cron.schedule(
      this.cronExpression,
      () => {
        this._scheduleWithJitter("cron");
      },
      { timezone: config.timezone }
    );
  }

  stop() {
    this._clearScheduledTimers();
    if (this.task) {
      if (typeof this.task.stop === "function") {
        this.task.stop();
      }
      if (typeof this.task === "object" && typeof clearInterval === "function") {
        clearInterval(this.task);
      }
      this.task = null;
    }
    this._stopWatching();
    this.log("Scheduler stopped.");
    return { ok: true };
  }

  async getStatus() {
    const fs = require("fs/promises");
    const pathModule = require("path");
    let pendingVideos = [];
    let counts = { pending: 0, posted: 0, failed: 0 };

    try {
      const pendingDir = this.queueDir;
      const postedDir = this.postedDir;
      const failedDir = this.failedDir;

      const [pendingEntries, postedEntries, failedEntries] = await Promise.all([
        fs.readdir(pendingDir, { withFileTypes: true }).catch(() => []),
        fs.readdir(postedDir, { withFileTypes: true }).catch(() => []),
        fs.readdir(failedDir, { withFileTypes: true }).catch(() => []),
      ]);

      const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif"]);
      const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
      const ALL_MEDIA = new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]);

      pendingVideos = pendingEntries
        .filter((entry) => entry.isFile() && ALL_MEDIA.has(pathModule.extname(entry.name).toLowerCase()))
        .map((entry) => {
          const ext = pathModule.extname(entry.name).toLowerCase();
          const isImage = IMAGE_EXTENSIONS.has(ext);
          return {
            name: entry.name,
            hasCaption: true,
            isImage,
            isVideo: VIDEO_EXTENSIONS.has(ext),
          };
        });

      const countMedia = (entries) =>
        entries.filter(
          (entry) => entry.isFile() && ALL_MEDIA.has(pathModule.extname(entry.name).toLowerCase())
        ).length;

      counts = {
        pending: pendingVideos.length,
        posted: countMedia(postedEntries),
        failed: countMedia(failedEntries),
      };
    } catch (error) {
      this.log(`Could not read queue directories: ${error.message}`, "warn");
    }

    return {
      running: Boolean(this.task),
      isPosting: this.isPosting,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      cronExpression: this.cronExpression,
      schedulePlan: this.schedulePlan,
      instantPost: this.instantPost,
      timezone: config.timezone,
      autoAddSound: config.autoAddSound,
      defaultSoundQuery: config.defaultSoundQuery,
      randomQueueOrder: config.randomQueueOrder,
      defaultCaption: config.defaultCaption,
      queue: { counts, pendingVideos },
      logs: this.logs,
    };
  }

  async setInstantPost(enabled) {
    this.instantPost = enabled;
    await this._saveState();
    if (enabled) {
      this._startWatching();
    } else {
      this._stopWatching();
    }
    this.log(`Instant post ${enabled ? "enabled" : "disabled"}.`);
    return { ok: true, instantPost: this.instantPost };
  }

  _startWatching() {
    if (this._queueWatcher) return;
    const chokidar = require("chokidar");
    this._queueWatcher = chokidar.watch(this.queueDir, {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 },
    });

    this._queueWatcher.on("add", (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif"]);
      const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
      const ALL_MEDIA = new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]);
      if (!ALL_MEDIA.has(ext)) return;

      if (this._watchDebounce) {
        clearTimeout(this._watchDebounce);
      }
      this._watchDebounce = setTimeout(() => {
        if (this.isPosting || !this.instantPost) return;
        this.log("New media detected in queue, posting immediately.");
        this.runOnce("instant-post");
      }, 2000);
    });
  }

  _stopWatching() {
    if (this._watchDebounce) {
      clearTimeout(this._watchDebounce);
      this._watchDebounce = null;
    }
    if (this._queueWatcher) {
      this._queueWatcher.close().catch(() => {});
      this._queueWatcher = null;
    }
  }
}

module.exports = { PinterestDaemonController };
