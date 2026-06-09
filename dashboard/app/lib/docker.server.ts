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
  startedAtMs: number | null;
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
      exitCode: c.State === "exited" ? parseExitCode(c.Status) : null,
      startedAtMs: null,
      createdMs: c.Created * 1000,
    };
  });
}
