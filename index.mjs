import createServer from "@cloud-cli/http";
import { mkdir, rm, writeFile } from "fs/promises";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { join, resolve } from "path";
import { createReadStream, existsSync } from "fs";

const authKey = process.env.API_KEY;
const baseDomain = process.env.BASE_DOMAIN;
const workingDir = process.env.DATA_PATH || process.cwd();
const mimeTypes = {
  css: "text/css",
  html: "text/html",
  js: "text/javascript",
  mjs: "text/javascript",
};

createServer(async function (request, response) {
  if (request.method === "POST" && request.url === "/:deploy") {
    if (request.headers.authorization !== authKey) {
      console.log("unauthorized key", request.headers.authorization);
      response.writeHead(400).end("");
      return;
    }

    let file;

    try {
      const buffer = await readStream(request);
      const hash = createHash("sha256")
        .update(buffer)
        .digest("hex")
        .slice(0, 8);

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

      response
        .writeHead(201)
        .end(`{"status": "success", "url": "https://${hash}.${baseDomain}"}`);
    } catch (error) {
      response
        .writeHead(400)
        .end(`{"status": "error", "error": ${JSON.stringify(String(error))}}`);
    } finally {
      if (file && existsSync(file)) {
        await rm(file);
      }
    }
    return;
  }

  if (["OPTIONS", "GET"].includes(request.method) === false) {
    return notFound(response);
  }

  const subdomain =
    String(request.headers["x-forwarded-for"])
      .replace(baseDomain, "")
      .split(".")[0] || "";

  if (!subdomain || !existsSync(join(workingDir, subdomain))) {
    return notFound(response);
  }

  const path = resolve(request.url);
  file = join(workingDir, subdomain, path);

  if (!existsSync(file)) {
    return notFound(response);
  }

  const extension = path.split(".").pop();
  response.setHeader("Cache-Control", "max-age=86400");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Content-Type", mimeTypes[extension] || "text/plain");

  console.log(file);
  createReadStream(file).pipe(response);
});

function notFound(response) {
  response.writeHead(404).end("Not found");
}

function readStream(stream) {
  return new Promise((r, s) => {
    const all = [];
    stream.on("data", (c) => all.push(c));
    stream.on("end", () => r(Buffer.concat(all)));
    stream.on("error", s);
  });
}
