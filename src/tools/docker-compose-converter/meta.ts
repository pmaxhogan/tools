import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "docker-compose-converter",
  matrixSlug: "docker-convert",
  icon: "Container",
  name: "Compose Converter",
  description: "Move between docker compose YAML and docker run commands in either direction.",
  category: "Homelab",
  keywords: [
    "docker run to docker compose",
    "composerize alternative",
    "docker compose to docker run",
    "docker compose converter",
    "docker run command generator",
    "compose yaml generator",
    "convert docker run to yaml",
  ],
  searchTerms: [
    "composerize",
    "decomposerize",
    "docker run yaml",
    "compose file from docker run",
    "podman run to compose",
    "docker-compose.yml generator",
    "convert compose to cli",
    "docker run command builder",
    "docker compose to cli command",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "direction",
      label: "Direction",
      default: "auto",
      options: [
        {
          value: "auto",
          label: "Auto detect",
          synonyms: ["automatic", "guess", "detect input", "either way"],
        },
        {
          value: "run-to-compose",
          label: "docker run to compose",
          synonyms: [
            "composerize",
            "cli to yaml",
            "command to compose",
            "docker run to docker compose",
            "podman run to compose",
          ],
        },
        {
          value: "compose-to-run",
          label: "compose to docker run",
          synonyms: [
            "decomposerize",
            "yaml to cli",
            "compose to command",
            "docker compose to docker run",
          ],
        },
      ],
    },
  ],
  examples: [
    {
      label: "docker run to compose",
      input:
        "docker run -d --name webapp -p 8080:80 -v appdata:/var/lib/app -e TZ=America/Chicago --restart unless-stopped nginx:alpine",
    },
    {
      label: "Compose to docker run",
      input: `services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
    environment:
      - NODE_ENV=production
    restart: always`,
    },
  ],
  http: { method: "POST", contentType: "text/plain" },
  copy: {
    what: "Translates a docker run command into a docker compose service definition, and a compose file back into one docker run command per service. It understands the flags people actually use: published ports with ranges and udp, named volumes and bind mounts, --mount syntax, environment variables and env files, networks, restart policies, healthcheck flags, capabilities, devices, ulimits, sysctls, logging options, memory and cpu limits, and GPU reservations. Several docker run commands chained with && become several services in one file, and anything it cannot express is listed in a not translated comment block instead of being silently dropped.",
    how: "Paste a docker run command (or a podman run command) and the converter emits a complete modern compose file, with named volumes hoisted into a top-level volumes section. Paste a compose file instead and it emits one readable multi-line docker run command per service. Direction is detected automatically, and you can force it with the Direction dropdown if your input is unusual.",
    why: "The popular composerize and decomposerize sites each handle one direction, drop flags they do not recognize without telling you, and wrap the tool in ads. This one does both directions, always shows you what it could not translate, and runs entirely in your browser: your files and inputs never leave your device.",
    faq: [
      {
        q: "Does it check that the resulting container actually works?",
        a: "No. This is a syntax translator, not a validator. It maps flags to compose keys and back, but it never pulls an image, resolves a registry, or checks that a path, device, or network exists on your host. Run the output and read the daemon errors the same way you would with a hand-written file.",
      },
      {
        q: "What cannot be translated, and how do I see it?",
        a: "Flags with no compose equivalent and compose keys with no CLI equivalent are collected into a comment block that starts with the line # not translated: at the end of the output. Detached mode (-d), --rm, and -P land there because compose has no equivalent key, and build, configs, secrets, profiles, and most deploy settings land there in the other direction. Nothing is dropped without a comment.",
      },
      {
        q: "Is my compose file uploaded anywhere?",
        a: "No. The conversion is a pure text transform that runs in your browser, so your files and inputs never leave your device. The page keeps working offline after the first load.",
      },
    ],
  },
};
