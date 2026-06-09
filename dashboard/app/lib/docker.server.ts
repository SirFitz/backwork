import http from "node:http";

const SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";

function engine<T = any>(path: string, timeoutMs = 6000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET, path, method: "GET", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if ((res.statusCode || 500) >= 400) return reject(new Error(`docker ${res.statusCode} ${path}`));
          try {
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("docker socket timeout")));
    req.end();
  });
}

export type ContainerInfo = {
  id: string;
  container: string; // docker name
  service: string; // friendly: coolify.resourceName || compose service || container
  role: string; // compose service (app/postgres/cache/worker)
  project: string;
  image: string;
  state: "running" | "exited" | "restarting" | "created" | "paused" | "dead" | string;
  health: "healthy" | "unhealthy" | "starting" | "none";
  status: string; // raw docker status text
  exitCode: number | null;
  ageSeconds: number | null; // how long ago the status changed (parsed from text)
  crashed: boolean; // recently exited with a non-clean code, or restarting
  createdMs: number;
};

type RawContainer = {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Created: number;
  Labels: Record<string, string>;
};

function parseExitCode(status: string): number | null {
  const m = status.match(/Exited \((\d+)\)/);
  return m ? Number(m[1]) : null;
}

const AGO_UNITS: Record<string, number> = {
  second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000,
};
function parseAgo(status: string): number | null {
  if (/About a minute ago/.test(status)) return 60;
  if (/Less than a second|seconds? ago/.test(status) && /Less than a second/.test(status)) return 0;
  const m = status.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (!m) return null;
  return Number(m[1]) * (AGO_UNITS[m[2]] || 0);
}
function parseHealth(status: string): ContainerInfo["health"] {
  if (status.includes("(healthy)")) return "healthy";
  if (status.includes("(unhealthy)")) return "unhealthy";
  if (status.includes("(health: starting)")) return "starting";
  return "none";
}

/** All containers on the host (running + stopped) with derived metadata. */
export async function listContainers(): Promise<ContainerInfo[]> {
  const raw = await engine<RawContainer[]>("/containers/json?all=true");
  return raw.map((c) => {
    const labels = c.Labels || {};
    const container = (c.Names?.[0] || c.Id).replace(/^\//, "");
    const service = labels["coolify.resourceName"] || labels["com.docker.compose.service"] || container;
    const exitCode = c.State === "exited" ? parseExitCode(c.Status) : null;
    const ageSeconds = parseAgo(c.Status);
    // A crash is: actively restarting, OR a recent (<24h) exit with a non-clean
    // code. Exit 0 (clean) and 143 (SIGTERM/intentional stop) are not crashes,
    // and an exit from long ago is stale, not an active incident.
    const crashed =
      c.State === "restarting" ||
      (c.State === "exited" &&
        exitCode !== null &&
        exitCode !== 0 &&
        exitCode !== 143 &&
        ageSeconds !== null &&
        ageSeconds < 86400);
    return {
      id: c.Id.slice(0, 12),
      container,
      service,
      role: labels["com.docker.compose.service"] || "",
      project: labels["coolify.projectName"] || "",
      image: (c.Image || "").split("@")[0],
      state: c.State,
      health: parseHealth(c.Status),
      status: c.Status,
      exitCode,
      ageSeconds,
      crashed,
      createdMs: c.Created * 1000,
    };
  });
}
