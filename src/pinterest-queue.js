const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif"]);
const ALL_MEDIA_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]);

function getCaptionPaths(mediaPath) {
  const parsed = path.parse(mediaPath);
  return [
    path.join(parsed.dir, `${parsed.name}.description`),
    path.join(parsed.dir, `${parsed.name}.txt`),
  ];
}

async function readCaption(mediaPath) {
  const captionPaths = getCaptionPaths(mediaPath);
  for (const cp of captionPaths) {
    try {
      const text = await fs.readFile(cp, "utf8");
      return text.trim();
    } catch {
      // try next
    }
  }
  return "";
}

async function listQueueMedia(queueDir) {
  const dir = queueDir || config.pinterestQueueDir;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const media = entries
    .filter((entry) => entry.isFile())
    .filter((entry) => ALL_MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name));

  media.sort((a, b) => a.localeCompare(b));
  return media;
}

function pickNextMedia(mediaItems) {
  if (mediaItems.length === 0) {
    return null;
  }
  if (config.randomQueueOrder) {
    return mediaItems[Math.floor(Math.random() * mediaItems.length)];
  }
  return mediaItems[0];
}

async function getNextQueuedItem(queueDir) {
  const media = await listQueueMedia(queueDir);
  const mediaPath = pickNextMedia(media);
  if (!mediaPath) {
    return null;
  }

  const caption = await readCaption(mediaPath);
  const ext = path.extname(mediaPath).toLowerCase();
  return {
    mediaPath,
    caption,
    captionPaths: getCaptionPaths(mediaPath),
    isImage: IMAGE_EXTENSIONS.has(ext),
    isVideo: VIDEO_EXTENSIONS.has(ext),
  };
}

module.exports = {
  getNextQueuedItem,
  getCaptionPaths,
  VIDEO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  ALL_MEDIA_EXTENSIONS,
};
