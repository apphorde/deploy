import createServer from "@cloud-cli/http";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { join, resolve } from "path";
import { createReadStream, existsSync } from "fs";

const authKey = process.env.API_KEY;
const baseDomain = process.env.BASE_DOMAIN;
const workingDir = process.env.DATA_PATH;
const mimeTypes = {
  css: "text/css",
  html: "text/html",
  js: "text/javascript",
  mjs: "text/javascript",
};

createServer(async function (request, response) {
  if (request.method === "POST" && request.url === "/:deploy") {
    return onDeploy(request, response);
  }

  if (["OPTIONS", "GET"].includes(request.method) === false) {
    return notFound(response);
  }

  onFetch(request, response);
});

function notFound(response) {
  response.writeHead(404).end("Not found");
}

async function onFetch(request, response) {
  const url = new URL(request.url, "http://localhost");
  const host = request.headers["x-forwarded-for"];

  let folder =
    host === baseDomain
      ? "."
      : String(host).replace(baseDomain, "").split(".")[0] || "";

  if (!folder) {
    return notFound(response);
  }

  if (folder !== ".") {
    const aliasFile = join(workingDir, folder + ".alias");
    if (!existsSync(join(workingDir, folder)) && existsSync(aliasFile)) {
      folder = (await readFile(aliasFile, "utf-8")).trim();
    }

    if (!existsSync(join(workingDir, folder))) {
      return notFound(response);
    }
  }

  const path = url.pathname === "/" ? "/index.html" : resolve(url.pathname);
  const file = join(workingDir, folder, path);

  if (!existsSync(file)) {
    return notFound(response);
  }

  const extension = path.split(".").pop();
  if (!url.searchParams.has("nocache")) {
    response.setHeader("Cache-Control", "max-age=86400");
  }

  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, POST");
  response.setHeader("Content-Type", mimeTypes[extension] || "text/plain");

  createReadStream(file).pipe(response);
}

async function onDeploy(request, response) {
  if (request.headers.authorization !== authKey) {
    console.log("unauthorized key", request.headers.authorization);
    response.writeHead(400).end("");
    return;
  }

  let file;

  try {
    const buffer = Buffer.concat(await request.toArray());
    const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 8);

    const dir = join(workingDir, hash);
    file = join(workingDir, hash + ".tgz");

    await writeFile(file, buffer);
    await mkdir(dir, { recursive: true });

    const sh = spawnSync("tar", [
      "-xzf",
      file,
      "--overwrite",
      "--directory",
      dir,
    ]);

    if (sh.status) {
      throw new Error("Failed to extract files: " + sh.error);
    }

    const manifest = join(dir, "package.json");
    let alias = "";
    let previousDir = "";

    if (existsSync(manifest)) {
      const json = JSON.parse(await readFile(manifest));

      if (json.name) {
        const aliasFile = join(workingDir, json.name + ".alias");
        previousDir = existsSync(aliasFile) && await readFile(aliasFile, 'utf-8') || '';
        await writeFile(aliasFile, hash, "utf-8");
        alias = json.name;
      }
    }

    if (previousDir) {
      await rm(join(workingDir, previousDir), { recursive: true, force: true });
    }

    response.writeHead(201).end(
      JSON.stringify({
        status: "success",
        url: `https://${hash}.${baseDomain}`,
        alias: alias ? `https://${alias}.${baseDomain}` : undefined,
      })
    );
  } catch (error) {
    response
      .writeHead(400)
      .end(`{"status": "error", "error": ${JSON.stringify(String(error))}}`);
  } finally {
    if (file && existsSync(file)) {
      await rm(file);
    }
  }
}
