"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const https = require("https");
const archiver = require("archiver");
const { dumpDB, dumpAllDatabases } = require("./dump.js");
const SYSTEM_DB_SET = new Set(["admin", "local", "config"]);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDiscordWebhookUrl(url) {
	if (typeof url !== "string") return false;
	return /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/i.test(
		url
	);
}

function formatTimestamp(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, "-");
}

function formatBytes(bytes) {
	const value = Number(bytes);
	if (!Number.isFinite(value) || value < 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let size = value;
	let unitIndex = 0;
	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}
	const decimals = unitIndex === 0 ? 0 : 2;
	return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function normalizeNumber(value) {
	const num = Number(value);
	return Number.isFinite(num) ? num : 0;
}

function parseBoolean(value, fallback = false) {
	if (typeof value === "boolean") return value;
	if (value === undefined || value === null || value === "") return fallback;
	const normalized = String(value).trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

async function listFilesRecursively(rootDir) {
	const entries = await fsp.readdir(rootDir, { withFileTypes: true });
	const out = [];
	for (const entry of entries) {
		const fullPath = path.join(rootDir, entry.name);
		if (entry.isDirectory()) {
			const nested = await listFilesRecursively(fullPath);
			out.push(...nested);
			continue;
		}
		if (entry.isFile()) out.push(fullPath);
	}
	return out;
}

async function sumFileSizes(filePaths) {
	let total = 0;
	for (const filePath of filePaths) {
		const stat = await fsp.stat(filePath);
		if (stat.isFile()) total += stat.size;
	}
	return total;
}

function calculateDelta(current, previous) {
	if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
	const diff = current - previous;
	return {
		current,
		previous,
		diff,
		direction: diff < 0 ? "decreased" : diff > 0 ? "increased" : "unchanged",
		absoluteDiff: Math.abs(diff),
	};
}

async function readSummaryIfExists(filePath) {
	try {
		const raw = await fsp.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") return parsed;
		return null;
	} catch (_) {
		return null;
	}
}

async function writeJson(filePath, payload) {
	await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function zipDirectory(sourceDir, zipFilePath) {
	await fsp.mkdir(path.dirname(zipFilePath), { recursive: true });

	return new Promise((resolve, reject) => {
		const output = fs.createWriteStream(zipFilePath);
		const archive = archiver("zip", { zlib: { level: 9 } });
		let settled = false;
		const finish = (err, result) => {
			if (settled) return;
			settled = true;
			if (err) reject(err);
			else resolve(result);
		};

		output.on("close", () =>
			finish(null, {
				zipFilePath,
				bytes: archive.pointer(),
			})
		);
		output.on("error", (err) => finish(err));
		archive.on("warning", (err) => {
			if (err && err.code === "ENOENT") return;
			finish(err);
		});
		archive.on("error", (err) => finish(err));

		archive.pipe(output);
		archive.directory(sourceDir, false);
		archive.finalize();
	});
}

async function splitFileIntoParts(filePath, partSizeBytes, outputDir) {
	if (!Number.isFinite(partSizeBytes) || partSizeBytes <= 0) {
		throw new Error("partSizeBytes must be a positive number");
	}
	await fsp.mkdir(outputDir, { recursive: true });
	const baseName = path.basename(filePath);
	const parts = [];
	let index = 1;
	const stream = fs.createReadStream(filePath, { highWaterMark: partSizeBytes });
	for await (const chunk of stream) {
		const partName = `${baseName}.part${String(index).padStart(3, "0")}`;
		const partPath = path.join(outputDir, partName);
		await fsp.writeFile(partPath, chunk);
		parts.push(partPath);
		index++;
	}
	return parts;
}

async function listDbNamesForStats(client, options = {}) {
	const dbName = options.dbName;
	const includeSystemDbs = !!options.includeSystemDbs;
	if (dbName) return [dbName];

	const adminDb = client.db().admin();
	const { databases } = await adminDb.listDatabases({ nameOnly: true });
	const names = [];
	for (const dbInfo of databases || []) {
		const name = dbInfo && dbInfo.name;
		if (!name) continue;
		if (!includeSystemDbs && SYSTEM_DB_SET.has(name)) continue;
		names.push(name);
	}
	return names;
}

async function collectDbStorageStats(client, options = {}) {
	const errors = [];
	let dbNames = [];
	try {
		dbNames = await listDbNamesForStats(client, options);
	} catch (err) {
		errors.push({ db: "*", error: (err && err.message) || String(err) });
	}

	const perDb = [];
	for (const name of dbNames) {
		try {
			const stats = await client.db(name).command({ dbStats: 1, scale: 1 });
			const dataSize = normalizeNumber(stats.dataSize);
			const storageSize = normalizeNumber(stats.storageSize);
			const indexSize = normalizeNumber(stats.indexSize);
			const totalSize = storageSize + indexSize;
			perDb.push({
				db: name,
				collections: normalizeNumber(stats.collections),
				dataSize,
				storageSize,
				indexSize,
				totalSize,
			});
		} catch (err) {
			errors.push({ db: name, error: (err && err.message) || String(err) });
		}
	}

	perDb.sort((a, b) => b.totalSize - a.totalSize);
	const totals = perDb.reduce(
		(acc, row) => {
			acc.dataSize += row.dataSize;
			acc.storageSize += row.storageSize;
			acc.indexSize += row.indexSize;
			acc.totalSize += row.totalSize;
			return acc;
		},
		{ dataSize: 0, storageSize: 0, indexSize: 0, totalSize: 0 }
	);

	return {
		perDb,
		errors,
		totals,
		generatedAt: new Date().toISOString(),
	};
}

function runHttpRequest(webhookUrl, headers, bodyBuffer) {
	return new Promise((resolve, reject) => {
		const url = new URL(webhookUrl);
		const req = https.request(
			{
				method: "POST",
				hostname: url.hostname,
				port: url.port || 443,
				path: `${url.pathname}${url.search || ""}`,
				headers,
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				res.on("end", () => {
					resolve({
						statusCode: res.statusCode || 0,
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			}
		);

		req.on("error", reject);
		req.write(bodyBuffer);
		req.end();
	});
}

async function postWithRetry(webhookUrl, headers, bodyBuffer, retries = 4) {
	let attempt = 0;
	while (attempt <= retries) {
		const res = await runHttpRequest(webhookUrl, headers, bodyBuffer);
		if (res.statusCode === 429 && attempt < retries) {
			let waitMs = 1500;
			try {
				const payload = JSON.parse(res.body || "{}");
				if (typeof payload.retry_after === "number") {
					waitMs =
						payload.retry_after > 1000
							? Math.ceil(payload.retry_after)
							: Math.ceil(payload.retry_after * 1000);
				}
			} catch (_) {
				// Ignore parse errors and keep fallback wait time.
			}
			await sleep(waitMs);
			attempt++;
			continue;
		}
		if (res.statusCode < 200 || res.statusCode >= 300) {
			throw new Error(
				`Discord webhook request failed (${res.statusCode}): ${
					(res.body || "").slice(0, 300) || "No response body"
				}`
			);
		}
		return;
	}
	throw new Error("Discord webhook request failed after retries.");
}

async function postDiscordMessage(webhookUrl, content) {
	const bodyBuffer = Buffer.from(JSON.stringify({ content }), "utf8");
	await postWithRetry(
		webhookUrl,
		{
			"Content-Type": "application/json",
			"Content-Length": Buffer.byteLength(bodyBuffer),
		},
		bodyBuffer
	);
}

async function postDiscordFile(webhookUrl, filePath, content) {
	const fileData = await fsp.readFile(filePath);
	const fileName = path.basename(filePath);
	const boundary = `----mongolite${Date.now().toString(16)}${Math.random()
		.toString(16)
		.slice(2)}`;
	const payload = Buffer.from(JSON.stringify({ content }), "utf8");
	const beforePayload = Buffer.from(
		`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="payload_json"\r\n` +
			`Content-Type: application/json\r\n\r\n`,
		"utf8"
	);
	const between = Buffer.from(
		`\r\n--${boundary}\r\n` +
			`Content-Disposition: form-data; name="files[0]"; filename="${fileName}"\r\n` +
			`Content-Type: application/octet-stream\r\n\r\n`,
		"utf8"
	);
	const ending = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
	const bodyBuffer = Buffer.concat([beforePayload, payload, between, fileData, ending]);

	await postWithRetry(
		webhookUrl,
		{
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
			"Content-Length": Buffer.byteLength(bodyBuffer),
		},
		bodyBuffer
	);
}

function buildBackupSummaryMessage(summary) {
	const lines = [
		"MongoDB backup (zip) completed.",
		`Backup date: ${summary.createdAt}`,
		`Scope: ${summary.scope}`,
		`DB storage now: ${formatBytes(summary.storage.totals.totalSize)} (data ${formatBytes(
			summary.storage.totals.dataSize
		)}, indexes ${formatBytes(summary.storage.totals.indexSize)})`,
		`Backup size: raw ${formatBytes(summary.rawBackupBytes)} -> zip ${formatBytes(
			summary.zipBytes
		)} (decrease ${formatBytes(summary.compressionSavedBytes)})`,
	];

	if (summary.storageDelta) {
		lines.push(
			`Storage vs previous backup: ${summary.storageDelta.direction} ${formatBytes(
				summary.storageDelta.absoluteDiff
			)}`
		);
	}
	if (summary.zipDelta) {
		lines.push(
			`Zip size vs previous backup: ${summary.zipDelta.direction} ${formatBytes(
				summary.zipDelta.absoluteDiff
			)}`
		);
	}

	if (summary.topDatabases.length) {
		const top = summary.topDatabases
			.map((row) => `${row.db}=${formatBytes(row.totalSize)}`)
			.join(" | ");
		lines.push(`Top DB storage: ${top}`);
	}

	if (summary.storage.errors.length) {
		lines.push(`Storage stat errors: ${summary.storage.errors.length}`);
	}

	return lines.join("\n");
}

/**
 * Create MongoDB dump files and upload them to Discord using a webhook.
 * @param {import('mongodb').MongoClient} client
 * @param {{
 *  webhookUrl?: string,
 *  outDir?: string,
 *  dbName?: string,
 *  includeSystemDbs?: boolean,
 *  includeSystemCollections?: boolean,
 *  maxFileMb?: number,
 *  intervalHours?: number
 * }} [options]
 */
async function runDiscordBackup(client, options = {}) {
	if (!client || typeof client.db !== "function") {
		throw new Error("A connected MongoClient instance is required");
	}

	const webhookUrl = options.webhookUrl || process.env.DISCORD_WEBHOOK_URL;
	if (!webhookUrl) {
		throw new Error("Missing Discord webhook URL. Set DISCORD_WEBHOOK_URL or pass --webhook.");
	}
	if (!isDiscordWebhookUrl(webhookUrl)) {
		throw new Error("Invalid Discord webhook URL format.");
	}

	const dbName = options.dbName || process.env.DISCORD_BACKUP_DB || "";
	const includeSystemDbs =
		options.includeSystemDbs !== undefined
			? options.includeSystemDbs
			: parseBoolean(process.env.DISCORD_BACKUP_INCLUDE_SYSTEM_DBS, false);
	const includeSystemCollections =
		options.includeSystemCollections !== undefined
			? options.includeSystemCollections
			: parseBoolean(process.env.DISCORD_BACKUP_INCLUDE_SYSTEM_COLLECTIONS, false);
	const maxFileMbValue =
		options.maxFileMb !== undefined
			? options.maxFileMb
			: Number(process.env.DISCORD_BACKUP_MAX_FILE_MB || 8);
	const maxFileMb = Number(maxFileMbValue);
	if (!Number.isFinite(maxFileMb) || maxFileMb <= 0) {
		throw new Error("maxFileMb must be a positive number.");
	}
	const maxFileBytes = Math.floor(maxFileMb * 1024 * 1024);

	const intervalHoursValue =
		options.intervalHours !== undefined
			? options.intervalHours
			: Number(process.env.DISCORD_BACKUP_INTERVAL_HOURS || 4);
	const intervalHours = Number(intervalHoursValue);
	const baseOutDir = path.resolve(
		options.outDir || process.env.DISCORD_BACKUP_OUT_DIR || "./mongodb-cli"
	);
	const runOutDir = path.join(baseOutDir, `backup-${formatTimestamp()}`);
	const latestSummaryPath = path.join(baseOutDir, "latest-backup-summary.json");
	const previousSummary = await readSummaryIfExists(latestSummaryPath);

	await fsp.mkdir(runOutDir, { recursive: true });

	if (dbName) {
		await dumpDB(client, dbName, { outDir: runOutDir, includeSystemCollections });
	} else {
		await dumpAllDatabases(client, {
			outDir: runOutDir,
			includeSystemDbs,
			includeSystemCollections,
		});
	}

	const files = (await listFilesRecursively(runOutDir)).sort();
	const rawBackupBytes = await sumFileSizes(files);
	const zipFilePath = path.join(baseOutDir, `${path.basename(runOutDir)}.zip`);
	const zipResult = await zipDirectory(runOutDir, zipFilePath);
	const zipBytes = zipResult.bytes;
	const compressionSavedBytes = Math.max(rawBackupBytes - zipBytes, 0);
	const storage = await collectDbStorageStats(client, {
		dbName,
		includeSystemDbs,
	});
	const scope = dbName ? `db:${dbName}` : "all-databases";
	const storageDelta = calculateDelta(
		storage.totals.totalSize,
		normalizeNumber(previousSummary && previousSummary.storage && previousSummary.storage.totals && previousSummary.storage.totals.totalSize)
	);
	const zipDelta = calculateDelta(
		zipBytes,
		normalizeNumber(previousSummary && previousSummary.zipBytes)
	);
	const summary = {
		createdAt: new Date().toISOString(),
		scope,
		dbName: dbName || null,
		runOutDir,
		zipFilePath,
		rawBackupBytes,
		zipBytes,
		compressionSavedBytes,
		compressionPercent:
			rawBackupBytes > 0
				? Number(((compressionSavedBytes / rawBackupBytes) * 100).toFixed(2))
				: 0,
		storage,
		storageDelta,
		zipDelta,
		topDatabases: storage.perDb.slice(0, 3),
		fileCount: files.length,
	};
	const summaryFilePath = path.join(runOutDir, "backup-summary.json");
	await writeJson(summaryFilePath, summary);
	await writeJson(latestSummaryPath, summary);

	await postDiscordMessage(webhookUrl, buildBackupSummaryMessage(summary));

	let uploaded = 0;
	const skipped = [];
	let splitParts = [];
	if (zipBytes > maxFileBytes) {
		const partsDir = path.join(runOutDir, "zip-parts");
		splitParts = await splitFileIntoParts(zipFilePath, maxFileBytes, partsDir);
		await postDiscordMessage(
			webhookUrl,
			`Zip exceeded ${maxFileMb}MB, split into ${splitParts.length} part(s) for upload.`
		);
		let partIndex = 0;
		for (const partPath of splitParts) {
			partIndex++;
			const partSize = (await fsp.stat(partPath)).size;
			await postDiscordFile(
				webhookUrl,
				partPath,
				`Backup zip part ${partIndex}/${splitParts.length} | ${path.basename(
					partPath
				)} | ${formatBytes(partSize)}`
			);
			uploaded++;
			await sleep(350);
		}
		await postDiscordMessage(
			webhookUrl,
			`To restore split zip: cat ${path.basename(zipFilePath)}.part* > ${path.basename(
				zipFilePath
			)}`
		);
	} else {
		await postDiscordFile(
			webhookUrl,
			zipFilePath,
			`MongoDB backup zip | ${path.basename(zipFilePath)} | ${formatBytes(zipBytes)}`
		);
		uploaded = 1;
	}

	await postDiscordMessage(
		webhookUrl,
		`Backup scheduler interval: ${intervalHours}h | uploaded=${uploaded}${
			splitParts.length ? ` (split parts=${splitParts.length})` : ""
		} | local backup dir=${runOutDir}`
	);

	return {
		dbName,
		runOutDir,
		zipFilePath,
		files,
		rawBackupBytes,
		zipBytes,
		compressionSavedBytes,
		storage,
		storageDelta,
		summaryFilePath,
		previousSummaryPath: latestSummaryPath,
		splitParts,
		uploaded,
		skipped,
		maxFileMb,
		intervalHours,
	};
}

module.exports = { runDiscordBackup };
