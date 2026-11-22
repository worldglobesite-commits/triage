import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTriageServer } from "./server.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

async function start(options) {
  const server = createTriageServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/api/triage` };
}

async function post(url, body) {
  const reply = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: reply.status, body: await reply.json() };
}

let mock;
before(async () => { mock = await start(); });
after(() => mock.server.close());

test("возвращает статус ready с полями topic и draft при валидном запросе", async () => {
  const { status, body } = await post(mock.url, { text: "Какая цена доставки?" });
  assert.equal(status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "pricing");
  assert.ok(body.draft.trim());
});

for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`${marker} возвращает manual_review`, async () => {
    const { status, body } = await post(mock.url, { text: `Вопрос ${marker}` });
    assert.equal(status, 200);
    assert.deepEqual(body, MANUAL_REVIEW);
  });
}

for (const [name, payload] of [
  ["missing text", {}],
  ["empty text", { text: "" }],
  ["blank text", { text: "   " }],
  ["non-string text", { text: 42 }],
  ["broken JSON", "{not json"],
  ["JSON null", "null"],
]) {
  test(`некорректный ввод (${name}) возвращает 400`, async () => {
    const { status, body } = await post(mock.url, payload);
    assert.equal(status, 400);
    assert.deepEqual(body, { status: "invalid_input" });
  });
}

test("модель, игнорирующая сигнал отмены, всё равно прерывается по таймауту", async () => {
  const slow = () => new Promise((resolve) => setTimeout(() => resolve("{}"), 2_000).unref());
  const { server, url } = await start({ classify: slow, timeoutMs: 50 });
  try {
    const started = Date.now();
    const { status, body } = await post(url, { text: "hello" });
    assert.equal(status, 200);
    assert.deepEqual(body, MANUAL_REVIEW);
    assert.ok(Date.now() - started < 1_000);
  } finally {
    server.close();
  }
});

test("дополнительные поля от модели не передаются клиенту", async () => {
  const classify = async () => JSON.stringify({ topic: "other", draft: "Ответ", secret: "x" });
  const { server, url } = await start({ classify });
  try {
    const { body } = await post(url, { text: "hello" });
    assert.deepEqual(body, { status: "ready", topic: "other", draft: "Ответ" });
  } finally {
    server.close();
  }
});
