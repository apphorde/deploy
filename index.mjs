import createServer from "@cloud-cli/http";
import { mkdir, readFile, rm, writeFile, readdir } from "fs/promises";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { join, resolve, basename, parse } from "path";
import { createReadStream, existsSync, statSync } from "fs";
import { pack } from "tar-stream";

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
  try {
    if (request.method === "POST") {
      return onDeploy(request, response);
    }

    if (request.method === "COPY") {
      return onBackup(request, response);
    }

    if (["OPTIONS", "GET"].includes(request.method) === false) {
      return notFound(response);
    }

    onFetch(request, response);
  } catch (e) {
    console.log(e);
    if (!response.headersSent) {
      response.writeHead(500).end();
    }
  }
});

async function onFetchNpm(request, response) {
  const host = request.headers["x-forwarded-for"];
  const url = new URL(request.url, "http://" + host);

  // /:npm/@foo%2fbar
  const parts = decodeURIComponent(url.pathname.replace("/:npm/", "")).split(
    "/"
  );

  // [@foo, bar, ?0.1.0.tgz]
  const [scope, name, version] = parts;
  console.log("npm", scope, name, version);

  if (!validateScope(scope) && validatePackageName(name)) {
    return notFound(response);
  }

  if (!version) {
    const manifest = await generateManifest(scope, name, host);
    response.end(JSON.stringify(manifest));
    return;
  }

  // [wd]/@foo/bar/0.1.0.mjs
  const folder = join(workingDir, scope, name);
  const file = join(folder, version + ".mjs");

  if (!existsSync(file)) {
    return notFound(response);
  }

  const content = await readFile(file, "utf-8");
  const manifest = JSON.stringify({
    name: `${scope}/${name}`,
    version,
    exports: "./index.mjs",
  });

  response.setHeader("content-type", "application/octet-stream");

  if (version !== "latest") {
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
  }

  const tar = pack();
  tar.entry({ name: "package.json" }, manifest);
  tar.entry({ name: "index.mjs" }, content);
  tar.pipe(response);
}

function validateScope(scope) {
  return scope && /^@[a-z]$/.test(String(scope));
}

function validatePackageName(name) {
  return name && /^[a-z-]$/.test(String(name));
}

async function onFetch(request, response) {
  const url = new URL(
    request.url,
    "http://" + request.headers["x-forwarded-for"]
  );

  const isNpmRequest = url.pathname.startsWith("/:npm/");

  if (isNpmRequest) {
    return onFetchNpm(request, response);
  }

  const file = await resolveFile(url);

  if (!file) {
    return notFound(response);
  }

  const extension = parse(file).ext;
  if (!url.searchParams.has("nocache")) {
    response.setHeader("Cache-Control", "max-age=86400");
  }

  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, POST");
  response.setHeader("Content-Type", mimeTypes[extension] || "text/plain");

  createReadStream(file).pipe(response);
}

async function resolveFile(url) {
  const { hostname, pathname } = url;

  let folder =
    hostname === baseDomain
      ? "."
      : String(hostname).replace(baseDomain, "").split(".")[0] || "";

  if (!folder) {
    return;
  }

  if (folder.startsWith("--")) {
    folder = folder.replace("--", "@");
  }

  if (folder !== ".") {
    const aliasFile = join(workingDir, folder + ".alias");
    if (!existsSync(join(workingDir, folder)) && existsSync(aliasFile)) {
      folder = (await readFile(aliasFile, "utf-8")).trim();
    }

    if (!existsSync(join(workingDir, folder))) {
      return;
    }
  }

  /**
   * /
   * /foo.css
   * /foo-bar
   * /foo-bar@1.0.0.mjs
   * /foo-bar/index.mjs
   */
  let candidates =
    pathname === "/"
      ? ["/index.html", "/index.mjs"]
      : [
          resolve(pathname),
          resolve(pathname.replace("@", "/")),
          resolve(pathname + "/index.mjs"),
          resolve(pathname + "/latest.mjs"),
        ];

  return candidates
    .map((c) => join(workingDir, folder, c))
    .find((f) => existsSync(f) && statSync(f).isFile());
}

async function onBackup(request, response) {
  if (request.headers.authorization !== authKey) {
    console.log("unauthorized key", request.headers.authorization);
    badRequest(response, "Unauthorized");
    return;
  }

  const url = new URL(request.url, "http://localhost");
  let name = basename(resolve(url.pathname.slice(1)));

  const aliasFile = join(workingDir, name + ".alias");
  if (existsSync(aliasFile) && statSync(aliasFile).isFile()) {
    name = await readFile(aliasFile, "utf8");
  }

  const dir = join(workingDir, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    notFound(response);
    return;
  }

  const sh = spawnSync("tar", ["c", "-z", "-C", dir, "-f", "-", "."]);
  if (sh.status) {
    const [_, stdout, stderr] = sh.output;
    console.log(stdout.toString("utf-8"));
    console.log(stderr.toString("utf-8"));

    badRequest(response, "Failed to generate file");
    return;
  }

  response.setHeader("Content-Type", "application/x-gzip");
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${name}.tgz"`
  );

  response.end(sh.stdout);
}

async function onDeploy(request, response) {
  if (request.headers.authorization !== authKey) {
    console.log("unauthorized key", request.headers.authorization);
    badRequest(response);
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
      const json = JSON.parse(await readFile(manifest, 'utf-8'));

      if (json.name) {
        const aliasFile = join(workingDir, json.name + ".alias");
        previousDir =
          (existsSync(aliasFile) && (await readFile(aliasFile, "utf-8"))) || "";
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

function notFound(response) {
  response.writeHead(404).end("Not found");
}

function badRequest(response, reason = "") {
  response.writeHead(400).end(reason);
}

async function generateManifest(scope, name, host) {
  const folder = join(workingDir, scope, name);
  const packageName = `${scope}/${name}`;
  const files = (await readdir(folder, { withFileTypes: true }))
    .filter((f) => f.isFile())
    .map((f) => parse(f.name).name);

  return {
    name: packageName,
    description: "",
    "dist-tags": {
      latest: "latest",
    },
    versions: Object.fromEntries(
      files.map((file) => [
        file,
        {
          name: packageName,
          version: file,
          description: "",
          dist: {
            tarball: new URL(
              `/:npm/${scope}/${name}/${file}.tgz`,
              "https://" + host
            ).toString(),
          },
          dependencies: {},
        },
      ])
    ),
    time: {
      created: "",
      modified: "",
      ...Object.fromEntries(
        files.map((file) => [
          file,
          new Date(statSync(join(folder, file + '.mjs')).ctimeMs).toISOString(),
        ])
      ),
    },
  };
}
