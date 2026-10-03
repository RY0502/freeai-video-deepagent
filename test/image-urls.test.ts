import assert from "node:assert/strict";
import test from "node:test";
import { extractImageUrlsFromPrompt } from "../src/tools/videoAgentTools.js";

test("extractImageUrlsFromPrompt returns empty array when no URLs in prompt", () => {
  assert.deepEqual(extractImageUrlsFromPrompt(""), []);
  assert.deepEqual(extractImageUrlsFromPrompt("Generate a cute cat video playing with yarn"), []);
  assert.deepEqual(extractImageUrlsFromPrompt("No urls here, just text!"), []);
});

test("extractImageUrlsFromPrompt extracts single HTTP and HTTPS URLs", () => {
  const prompt = "Animate this character: https://images.example.com/character1.png in cinematic style";
  assert.deepEqual(extractImageUrlsFromPrompt(prompt), [
    "https://images.example.com/character1.png",
  ]);

  const httpPrompt = "Reference image at http://test.com/photo.jpg please";
  assert.deepEqual(extractImageUrlsFromPrompt(httpPrompt), [
    "http://test.com/photo.jpg",
  ]);
});

test("extractImageUrlsFromPrompt strips trailing punctuation", () => {
  const prompt = "Use https://cdn.example.com/hero.png, https://cdn.example.com/background.jpg; and https://cdn.example.com/item.png!";
  assert.deepEqual(extractImageUrlsFromPrompt(prompt), [
    "https://cdn.example.com/hero.png",
    "https://cdn.example.com/background.jpg",
    "https://cdn.example.com/item.png",
  ]);
});

test("extractImageUrlsFromPrompt deduplicates identical URLs and caps at 5", () => {
  const prompt = [
    "https://cdn.example.com/1.png",
    "https://cdn.example.com/2.png",
    "https://cdn.example.com/1.png", // duplicate
    "https://cdn.example.com/3.png",
    "https://cdn.example.com/4.png",
    "https://cdn.example.com/5.png",
    "https://cdn.example.com/6.png", // 6th URL - should be capped at 5
    "https://cdn.example.com/7.png",
  ].join(" ");

  const urls = extractImageUrlsFromPrompt(prompt);
  assert.equal(urls.length, 5);
  assert.deepEqual(urls, [
    "https://cdn.example.com/1.png",
    "https://cdn.example.com/2.png",
    "https://cdn.example.com/3.png",
    "https://cdn.example.com/4.png",
    "https://cdn.example.com/5.png",
  ]);
});

test("extractImageUrlsFromPrompt ignores non-http/https protocols", () => {
  const prompt = "Check ftp://example.com/file.png and file:///local/path.png and https://valid.com/image.png";
  assert.deepEqual(extractImageUrlsFromPrompt(prompt), [
    "https://valid.com/image.png",
  ]);
});
