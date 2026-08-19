import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { run } from "./index";

const RICH_RUN = `docker run -d --name webapp \\
  -p 8080:80 -p 5353:53/udp \\
  -v appdata:/var/lib/app -v /etc/localtime:/etc/localtime:ro \\
  -e "TZ=America/Chicago" -e PUID=1000 -e SECRET \\
  --restart unless-stopped \\
  --health-cmd "curl -f http://localhost/ || exit 1" --health-interval 30s --health-retries 3 \\
  --cap-add NET_ADMIN --cap-drop ALL \\
  --label "traefik.enable=true" \\
  -it --bogus-flag \\
  ghcr.io/example/webapp:1.4 --config "/etc/app config.yml" --verbose`;

const RICH_COMPOSE = `services:
  webapp:
    image: ghcr.io/example/webapp:1.4
    container_name: webapp
    restart: unless-stopped
    command:
      - --config
      - /etc/app config.yml
      - --verbose
    ports:
      - "8080:80"
      - "5353:53/udp"
    volumes:
      - appdata:/var/lib/app
      - /etc/localtime:/etc/localtime:ro
    environment:
      - TZ=America/Chicago
      - PUID=1000
      - SECRET
    labels:
      - traefik.enable=true
    cap_add:
      - NET_ADMIN
    cap_drop:
      - ALL
    stdin_open: true
    tty: true
    healthcheck:
      test:
        - CMD-SHELL
        - curl -f http://localhost/ || exit 1
      interval: 30s
      retries: 3
volumes:
  appdata: {}

# notes:
#   -d is a runtime choice, not a compose key. Run: docker compose up -d

# not translated:
#   --bogus-flag`;

const API_COMPOSE = `services:
  api:
    image: node:20-alpine
    container_name: api
    ports:
      - "3000:3000"
      - "9229:9229"
    environment:
      NODE_ENV: production
      LOG_LEVEL: debug
      HOME_URL: https://example.test/a b
    entrypoint:
      - /bin/sh
      - -c
    command: node server.js
    depends_on:
      - db
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O- http://localhost:3000/health"]
      interval: 10s
      timeout: 3s
      retries: 5
    restart: always
`;

const API_RUN = `# service: api
# start these first: db
docker run \\
  --name api \\
  --restart always \\
  --publish 3000:3000 \\
  --publish 9229:9229 \\
  --env NODE_ENV=production \\
  --env LOG_LEVEL=debug \\
  --env 'HOME_URL=https://example.test/a b' \\
  --health-cmd 'wget -q -O- http://localhost:3000/health' \\
  --health-interval 10s \\
  --health-timeout 3s \\
  --health-retries 5 \\
  --entrypoint /bin/sh \\
  node:20-alpine -c node server.js`;

function expectToolError(fn: () => unknown, code: string): ToolError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe(code);
    return err as ToolError;
  }
  throw new Error(`expected a ToolError with code ${code}`);
}

describe("docker-compose-converter: docker run to compose", () => {
  it("converts a rich docker run command, hoisting named volumes and listing what it skipped", () => {
    expect(run(RICH_RUN, { direction: "auto" })).toBe(RICH_COMPOSE);
  });

  it("auto-detects the direction without an explicit option", () => {
    expect(run(RICH_RUN, {})).toBe(RICH_COMPOSE);
  });

  it("parses --mount into the long volume syntax and flags unknown mount options", () => {
    const out = run(
      "podman run --mount type=bind,src=/srv/data,dst=/data,readonly " +
        "--mount type=volume,src=cache,dst=/cache,volume-nocopy alpine",
      { direction: "run-to-compose" },
    );
    expect(out).toBe(`services:
  alpine:
    image: alpine
    volumes:
      - type: bind
        source: /srv/data
        target: /data
        read_only: true
      - type: volume
        source: cache
        target: /cache
volumes:
  cache: {}

# not translated:
#   --mount option volume-nocopy`);
  });

  it("turns several chained run commands into several services", () => {
    const out = run(
      "docker run -d --name db postgres:16 && docker container run -d -p 80:80 nginx",
      {
        direction: "auto",
      },
    );
    expect(out).toBe(`services:
  db:
    image: postgres:16
    container_name: db
  nginx:
    image: nginx
    ports:
      - "80:80"

# notes:
#   -d is a runtime choice, not a compose key. Run: docker compose up -d`);
  });

  it("dedupes service names taken from the same image", () => {
    const out = run("docker run nginx\ndocker run nginx", { direction: "run-to-compose" });
    expect(out).toContain("  nginx:");
    expect(out).toContain("  nginx-2:");
  });

  it("keeps a non-run command in the not translated block instead of dropping it", () => {
    const out = run("docker network create web && docker run --network web nginx", {
      direction: "run-to-compose",
    });
    expect(out).toContain("#   docker network create web (not a container run command)");
    expect(out).toContain("external: true");
  });

  it("maps --gpus, --ulimit, --sysctl, and logging flags", () => {
    const out = run(
      "docker run --gpus all --ulimit nofile=1024:2048 --sysctl net.core.somaxconn=1024 " +
        "--log-driver json-file --log-opt max-size=10m nvidia/cuda",
      { direction: "run-to-compose" },
    );
    expect(out).toContain("driver: nvidia");
    expect(out).toContain("count: all");
    expect(out).toContain("- gpu");
    expect(out).toContain("soft: 1024");
    expect(out).toContain("hard: 2048");
    expect(out).toContain("- net.core.somaxconn=1024");
    expect(out).toContain("max-size: 10m");
  });
});

describe("docker-compose-converter: compose to docker run", () => {
  it("rebuilds one docker run command per service", () => {
    expect(run(API_COMPOSE, { direction: "auto" })).toBe(API_RUN);
  });

  it("reports compose keys that have no docker run equivalent", () => {
    const out = run(
      "services:\n  app:\n    build: ./app\n    image: myapp:dev\n    profiles: [dev]\n",
      {
        direction: "compose-to-run",
      },
    );
    expect(out).toBe(`# service: app
docker run \\
  myapp:dev
# not translated:
#   build: ./app
#   profiles:
#     - dev`);
  });

  it("handles list environment, map labels, and the long volume syntax", () => {
    const out = run(
      `services:
  web:
    image: caddy
    environment:
      - TZ=UTC
      - PASSTHROUGH
    labels:
      owner: max
    volumes:
      - type: bind
        source: /srv/site
        target: /srv
        read_only: true
    networks:
      backend:
        aliases:
          - site
`,
      { direction: "compose-to-run" },
    );
    expect(out).toContain("--env TZ=UTC");
    expect(out).toContain("--env PASSTHROUGH");
    expect(out).toContain("--label owner=max");
    expect(out).toContain("--mount type=bind,src=/srv/site,dst=/srv,readonly");
    expect(out).toContain("--network backend");
    expect(out).toContain("--network-alias site");
  });
});

describe("docker-compose-converter: round trip", () => {
  it("preserves image, ports, and environment through run to compose and back", () => {
    const original = "docker run -p 8080:80 -p 5353:53/udp -e TZ=UTC -e PUID=1000 nginx:alpine";
    const back = run(run(original, { direction: "run-to-compose" }), {
      direction: "compose-to-run",
    });
    expect(back).toContain("--publish 8080:80");
    expect(back).toContain("--publish 5353:53/udp");
    expect(back).toContain("--env TZ=UTC");
    expect(back).toContain("--env PUID=1000");
    expect(back.trimEnd().endsWith("nginx:alpine")).toBe(true);
  });
});

describe("docker-compose-converter: errors", () => {
  it("rejects empty input", () => {
    const err = expectToolError(() => run("   \n  ", {}), "empty-input");
    expect(err.fix).toContain("docker run");
  });

  it("rejects broken YAML and names the line", () => {
    const err = expectToolError(
      () => run("services:\n  web:\n   image: x\n  - b\n", { direction: "compose-to-run" }),
      "bad-yaml",
    );
    expect(err.message).toContain("line 4");
  });

  it("rejects input that is not a run command when that direction is forced", () => {
    expectToolError(() => run("echo hello", { direction: "run-to-compose" }), "not-a-run-command");
  });

  it("rejects a compose file with no services", () => {
    expectToolError(() => run("version: '3'\n", { direction: "compose-to-run" }), "no-services");
    expectToolError(() => run("just some text", { direction: "auto" }), "no-services");
  });

  it("rejects a run command with no image", () => {
    expectToolError(() => run("docker run -d --rm", { direction: "run-to-compose" }), "no-image");
  });

  it("rejects a flag left without its value", () => {
    expectToolError(
      () => run("docker run -d --name", { direction: "run-to-compose" }),
      "missing-flag-value",
    );
  });
});
