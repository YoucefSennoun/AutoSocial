const test = require("node:test");
const assert = require("node:assert/strict");

const { _private } = require("../src/tiktok-uploader");

const { isLikelyPublishCandidateInfo } = _private;

test("TikTok publish candidate rejects the Studio sidebar Posts item", () => {
  const candidate = {
    disabled: false,
    inNavigation: true,
    rect: { left: 48, top: 300, width: 120, height: 36 },
    role: "button",
    tagName: "button",
    text: "Posts",
    viewportWidth: 1200,
  };

  assert.equal(isLikelyPublishCandidateInfo(candidate), false);
});

test("TikTok publish candidate accepts the main upload Post button", () => {
  const candidate = {
    disabled: false,
    inNavigation: false,
    rect: { left: 900, top: 780, width: 160, height: 44 },
    role: "",
    tagName: "button",
    text: "Post",
    viewportWidth: 1200,
  };

  assert.equal(isLikelyPublishCandidateInfo(candidate), true);
});

test("TikTok publish candidate rejects ambiguous left-side Post controls", () => {
  const candidate = {
    disabled: false,
    inNavigation: false,
    rect: { left: 80, top: 320, width: 120, height: 36 },
    role: "",
    tagName: "button",
    text: "Post",
    viewportWidth: 1200,
  };

  assert.equal(isLikelyPublishCandidateInfo(candidate), false);
});

test("TikTok publish candidate allows Post controls in the main content area", () => {
  const candidate = {
    disabled: false,
    inNavigation: false,
    rect: { left: 300, top: 760, width: 160, height: 44 },
    role: "",
    tagName: "button",
    text: "Post",
    viewportWidth: 1200,
  };

  assert.equal(isLikelyPublishCandidateInfo(candidate), true);
});
