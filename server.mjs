import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

const TOPICS = new Set(["delivery", "pricing", "other"]);
const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 1_000_000;
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

class InvalidInputError extends Error {}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

async function readText(request) {
	const chunks = [];

	let size = 0;

	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new InvalidInputError("Body too large");
		chunks.push(chunk);
	}

	let body;

	try {
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new InvalidInputError("Invalid JSON");
	}

	if (typeof body?.text !== "string" || body.text.trim() === "") {
		throw new InvalidInputError("text must be a non-empty string");
	}

	return body.text;
}

// Запускает модель в гонке с таймаутом, чтобы провайдер, который игнорирует сигнал отмены, не повесил запрос
async function callModel(classify, text, timeoutMs) {
	const controller = new AbortController();

	let timer;

	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error("Model timeout"));
		}, timeoutMs);
	});

	try {
		return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

// Вывод модели не является доверенным: возвращает { topic, draft } только если он валиден, иначе null
function parseModelOutput(raw) {
	let value;

	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}

	if (typeof value?.topic !== "string" || !TOPICS.has(value.topic)) return null;
	if (typeof value.draft !== "string" || value.draft.trim() === "") return null;
	
	return { topic: value.topic, draft: value.draft };
}

async function handleTriage(request, response, { classify, timeoutMs }) {
	let text;

	try {
		text = await readText(request);
	} catch (error) {
		if (!(error instanceof InvalidInputError)) throw error;
		// Connection: close, так как слишком большое тело запроса могло быть прочитано не полностью
		return json(response, 400, { status: "invalid_input" }, { Connection: "close" });
	}

	let result = null;

	try {
		result = parseModelOutput(await callModel(classify, text, timeoutMs));
	} catch (error) {
		console.error("Model call failed:", error.message);
	}
	if (!result) return json(response, 200, MANUAL_REVIEW);

	return json(response, 200, { status: "ready", ...result });
}

export function createTriageServer({ html = "", classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
	return createServer(async (request, response) => {
		const path = new URL(request.url, "http://localhost").pathname;

		if (request.method === "GET" && path === "/") {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(html);
			return;
		}

		if (request.method !== "POST" || path !== "/api/triage") {
			return json(response, 404, { status: "not_found" });
		}

		try {
			await handleTriage(request, response, { classify, timeoutMs });
		} catch (error) {
			console.error("Unexpected error:", error);
			if (!response.headersSent) json(response, 500, { status: "server_error" });
		}
	});
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  	const html = await readFile(new URL("./index.html", import.meta.url));
	
  	createTriageServer({ html }).listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
