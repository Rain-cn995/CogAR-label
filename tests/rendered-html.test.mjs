import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the CogAR timestamp review workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>CogAR · Video Timestamp Review<\/title>/i);
  assert.match(html, /<main class="app-shell">/);
  assert.match(html, /<h1>Cog<span>AR<\/span><\/h1>/);
  assert.match(html, /Upload your video/);
  assert.match(html, /Upload your CSV/);
  assert.match(html, /Local files · nothing is uploaded/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("renders local video and CSV pickers before any files are selected", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /<input type="file" accept="video\/\*"\/>/);
  assert.match(html, /<input class="visually-hidden" type="file" accept="\.csv,text\/csv,text\/plain"\/>/);
  assert.match(html, /<button class="reset-button" type="button" disabled="">Reset<\/button>/);
  assert.match(html, /0<!-- --> timestamps/);
  assert.doesNotMatch(html, /Export edited CSV/);
});
