const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");
const { getNextQueuedItem, getCaptionPaths } = require("./pinterest-queue");
const { uploadPin } = require("./pinterest-uploader");
const { ensureDirectories, fileExists, moveWithTimestamp } = require("./fs-utils");

async function moveCaptionsIfExists(captionPaths, targetDir) {
  const moved = [];
  for (const cp of captionPaths) {
    if (await fileExists(cp)) {
      const result = await moveFileSafely(cp, targetDir, "caption file");
      if (result) moved.push(result);
    }
  }
  return moved.length > 0 ? moved[0] : null;
}

async function moveFileSafely(sourcePath, targetDir, label) {
  try {
    return await moveWithTimestamp(sourcePath, targetDir);
  } catch (error) {
    console.error(`Could not move ${label}: ${error.message}`);
    return null;
  }
}

async function postSinglePin({ mediaPath, caption, postedDir, failedDir, accountId, boardName, destinationLink }) {
  const posted = postedDir || config.pinterestPostedDir;
  const failed = failedDir || config.pinterestFailedDir;
  await ensureDirectories([posted, failed]);

  const result = await uploadPin({ mediaPath, caption, accountId, boardName, destinationLink });
  const captionPaths = getCaptionPaths(mediaPath);

  if (result.ok) {
    const movedMedia = await moveFileSafely(mediaPath, posted, "posted pin");
    const movedCaption = await moveCaptionsIfExists(captionPaths, posted);
    if (!movedMedia) {
      return {
        ok: false,
        error: "Pin posted, but could not archive file from Pinterest queue.",
        screenshotPath: result.screenshotPath,
      };
    }
    return { ok: true, movedMedia, movedCaption, board: result.board };
  }

  const movedMedia = await moveFileSafely(mediaPath, failed, "failed pin");
  const movedCaption = await moveCaptionsIfExists(captionPaths, failed);
  return {
    ok: false,
    movedMedia,
    movedCaption,
    error: result.error,
    screenshotPath: result.screenshotPath,
  };
}

async function postNextFromQueue({ source, queueDir, postedDir, failedDir, accountId } = {}) {
  const queue = queueDir || config.pinterestQueueDir;
  const posted = postedDir || config.pinterestPostedDir;
  const failed = failedDir || config.pinterestFailedDir;
  await ensureDirectories([queue, posted, failed]);

  const nextItem = await getNextQueuedItem(queue);
  if (!nextItem) {
    return { ok: true, skipped: true, reason: "Pinterest queue is empty." };
  }

  return postSinglePin({ ...nextItem, postedDir: posted, failedDir: failed, accountId });
}

async function postFromManualInput(mediaPath, caption) {
  const resolvedPath = path.resolve(mediaPath);
  await fs.access(resolvedPath);
  return postSinglePin({
    mediaPath: resolvedPath,
    caption: caption || "",
  });
}

module.exports = {
  postNextFromQueue,
  postFromManualInput,
};
