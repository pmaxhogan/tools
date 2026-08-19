<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ArrowRight, KeyRound, LogIn } from "lucide-vue-next";
import { ToolError, type OptionSpec, type ToolMeta } from "@/tools/types";
import { run } from "@/tools/passkey-tester/index";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import OptionControl from "../OptionControl.vue";
import OutputView from "../OutputView.vue";

/**
 * Bespoke panel for the Passkey Tester.
 *
 * The pure layer (PROJECT.md rule 27) decodes an attestation object, raw
 * authenticator data, or a credential JSON blob. It cannot run a WebAuthn
 * ceremony, because that needs navigator.credentials and a user gesture, so
 * this panel owns exactly that: it drives the two ceremonies, serializes what
 * the authenticator handed back into the JSON shape the logic layer already
 * accepts, and hands it to the same run() the Decode tab uses.
 *
 * Nothing here talks to a server. A WebAuthn ceremony is entirely local
 * between the page and the authenticator, so your files and inputs never
 * leave your device. The credential created in a session lives in this
 * component's memory only: never localStorage, never the URL fragment.
 *
 * SSR safety: navigator, window, and location are read only inside onMounted
 * or inside a click handler, never at setup time.
 */
const props = defineProps<{ meta: ToolMeta }>();

/**
 * A NotAllowedError this fast cannot be a person dismissing a prompt, so it is
 * read as the platform refusing "direct" attestation outright and the create
 * is retried once with "none". A slower one means the prompt really was shown
 * and dismissed, and re-prompting over that would be rude.
 */
const FAST_FAILURE_MS = 1500;

interface PanelError {
  message: string;
  fix?: string;
}

type Support = "checking" | "yes" | "no";

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const support = ref<Support>("checking");
const tab = ref("register");
const hostname = ref("this site");

/** The credential from this session, kept in memory for the sign in call. */
const credentialBytes = ref<Uint8Array<ArrayBuffer> | null>(null);
const credentialId = ref<string | null>(null);

const registerJson = ref<string | null>(null);
const registerError = ref<PanelError | null>(null);

const authJson = ref<string | null>(null);
const authError = ref<PanelError | null>(null);

const decodeInput = ref("");

const busy = ref<"register" | "authenticate" | null>(null);

/** The detail level, in the loose shape OptionControl speaks. */
const opts = ref<Record<string, unknown>>({ view: "summary" });
const view = computed(() => String(opts.value.view ?? "summary"));

const viewSpec = computed<OptionSpec | undefined>(() =>
  props.meta.options?.find((o) => o.id === "view"),
);

/* ------------------------------------------------------------------ *
 * decoding, shared by all three sections
 * ------------------------------------------------------------------ */

interface Decoded {
  rows: Record<string, string> | null;
  error: PanelError | null;
}

function decode(text: string | null): Decoded {
  if (!text || !text.trim()) return { rows: null, error: null };
  try {
    return { rows: run(text, { view: view.value }), error: null };
  } catch (err) {
    if (err instanceof ToolError) {
      return { rows: null, error: { message: err.message, fix: err.fix } };
    }
    return {
      rows: null,
      error: { message: err instanceof Error ? err.message : "That value could not be decoded." },
    };
  }
}

const registerResult = computed(() => decode(registerJson.value));
const authResult = computed(() => decode(authJson.value));
const decodeResult = computed(() => decode(decodeInput.value));

/* ------------------------------------------------------------------ *
 * bytes
 * ------------------------------------------------------------------ */

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The buffer parameter is pinned to ArrayBuffer rather than left as the
 * default ArrayBufferLike: BufferSource, which every WebAuthn option field
 * wants, does not accept a view that might be backed by a SharedArrayBuffer.
 */
function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/* ------------------------------------------------------------------ *
 * errors
 * ------------------------------------------------------------------ */

function nameOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "name" in err) {
    const value = (err as { name?: unknown }).name;
    if (typeof value === "string") return value;
  }
  return "";
}

function messageOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    const value = (err as { message?: unknown }).message;
    if (typeof value === "string" && value) return value;
  }
  return "No further detail was given.";
}

function describe(err: unknown, phase: "create" | "get"): PanelError {
  const name = nameOf(err);

  if (name === "NotAllowedError") {
    return {
      message: "The prompt was dismissed or timed out",
      fix: "Nothing was created or signed. Press the button again and finish the browser prompt.",
    };
  }
  if (name === "InvalidStateError" && phase === "create") {
    return {
      message: "This authenticator already has a credential for this site",
      fix: `Delete the ${hostname.value} passkey from your password manager or device, or pick a different authenticator when the prompt asks.`,
    };
  }
  if (name === "SecurityError") {
    return {
      message: "The relying party ID does not match this page",
      fix: `A passkey is bound to an origin. The relying party ID has to be ${hostname.value} or a registrable parent domain of it, and the page has to be served over HTTPS (localhost aside) and not inside a cross origin frame.`,
    };
  }
  if (name === "AbortError") {
    return {
      message: "The ceremony was cancelled",
      fix: "Press the button again to start a new one.",
    };
  }
  if (name === "NotSupportedError") {
    return {
      message: "This authenticator cannot make a credential with these options",
      fix: "It may not support ES256 or RS256, or it may not be able to store a discoverable credential. Try another authenticator, such as your phone.",
    };
  }
  return { message: name ? `${name}: ${messageOf(err)}` : messageOf(err) };
}

/* ------------------------------------------------------------------ *
 * registration
 * ------------------------------------------------------------------ */

async function createCredential(attestation: "direct" | "none"): Promise<PublicKeyCredential> {
  // The options object is written inline so the DOM lib types it in place: the
  // named option types are types only, never runtime globals, and naming them
  // here would read as an undefined identifier.
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: "Passkey Tester" },
      challenge: randomBytes(32),
      user: {
        id: randomBytes(16),
        name: "test@example",
        displayName: "Test user",
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      attestation,
      timeout: 60000,
    },
  });
  if (!credential) throw new Error("The browser returned no credential.");
  return credential as PublicKeyCredential;
}

async function register() {
  if (busy.value !== null) return;
  busy.value = "register";
  registerError.value = null;
  try {
    const startedAt = Date.now();
    let credential: PublicKeyCredential;
    try {
      credential = await createCredential("direct");
    } catch (err) {
      if (Date.now() - startedAt < FAST_FAILURE_MS && nameOf(err) === "NotAllowedError") {
        credential = await createCredential("none");
      } else {
        throw err;
      }
    }

    const response = credential.response as AuthenticatorAttestationResponse;
    registerJson.value = JSON.stringify(
      {
        type: credential.type,
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        response: {
          attestationObject: toBase64Url(response.attestationObject),
          clientDataJSON: toBase64Url(response.clientDataJSON),
        },
      },
      null,
      2,
    );
    credentialBytes.value = new Uint8Array(credential.rawId);
    credentialId.value = credential.id;
  } catch (err) {
    registerJson.value = null;
    registerError.value = describe(err, "create");
  } finally {
    busy.value = null;
  }
}

/* ------------------------------------------------------------------ *
 * authentication
 * ------------------------------------------------------------------ */

async function authenticate() {
  if (busy.value !== null) return;
  busy.value = "authenticate";
  authError.value = null;
  try {
    const stored = credentialBytes.value;
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId: location.hostname,
        userVerification: "preferred",
        timeout: 60000,
        // With no credential from this session the request stays open, so any
        // discoverable passkey already stored for this site can answer it.
        allowCredentials: stored ? [{ type: "public-key" as const, id: stored }] : [],
      },
    });
    if (!credential) throw new Error("The browser returned no assertion.");

    const assertion = credential as PublicKeyCredential;
    const response = assertion.response as AuthenticatorAssertionResponse;
    authJson.value = JSON.stringify(
      {
        type: assertion.type,
        id: assertion.id,
        rawId: toBase64Url(assertion.rawId),
        response: {
          authenticatorData: toBase64Url(response.authenticatorData),
          clientDataJSON: toBase64Url(response.clientDataJSON),
          signature: toBase64Url(response.signature),
          ...(response.userHandle ? { userHandle: toBase64Url(response.userHandle) } : {}),
        },
      },
      null,
      2,
    );
  } catch (err) {
    authJson.value = null;
    authError.value = describe(err, "get");
  } finally {
    busy.value = null;
  }
}

/* ------------------------------------------------------------------ *
 * moving a ceremony result into the decoder
 * ------------------------------------------------------------------ */

function sendToDecode(json: string | null) {
  if (!json) return;
  decodeInput.value = json;
  tab.value = "decode";
}

/* ------------------------------------------------------------------ *
 * feature detection, after hydration so the server frame never guesses
 * ------------------------------------------------------------------ */

onMounted(() => {
  hostname.value = location.hostname;
  support.value = "PublicKeyCredential" in window ? "yes" : "no";
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <Tabs v-model="tab" class="w-full">
      <TabsList class="flex w-full flex-wrap">
        <TabsTrigger value="register">Register</TabsTrigger>
        <TabsTrigger value="authenticate">Authenticate</TabsTrigger>
        <TabsTrigger value="decode">Decode</TabsTrigger>
      </TabsList>

      <!-- ------------------------------------------------- register -->
      <TabsContent value="register" class="flex flex-col gap-4 pt-4">
        <p class="max-w-[68ch] text-sm text-muted-foreground">
          Creates a real passkey for {{ hostname }} with your device or password manager, then
          decodes what came back: the attestation format, every authenticator data flag, the AAGUID,
          and the COSE public key.
        </p>

        <div
          v-if="support === 'no'"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-semibold">This browser has no WebAuthn support</span>
          <span class="text-muted-foreground">
            window.PublicKeyCredential is missing, so no passkey can be created or used here. The
            Decode tab still works: paste a credential captured somewhere else.
          </span>
        </div>

        <div v-else-if="support === 'yes'" class="flex flex-wrap items-center gap-2">
          <Button type="button" :disabled="busy !== null" @click="register">
            <KeyRound class="size-3.5" aria-hidden="true" />
            {{ busy === "register" ? "Waiting for the authenticator…" : "Create Passkey" }}
          </Button>
          <Button
            v-if="registerJson"
            type="button"
            variant="outline"
            @click="sendToDecode(registerJson)"
          >
            <ArrowRight class="size-3.5" aria-hidden="true" />
            Open in Decode
          </Button>
        </div>

        <div
          v-if="registerError"
          role="alert"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-semibold text-destructive">{{ registerError.message }}</span>
          <span v-if="registerError.fix" class="text-muted-foreground">{{
            registerError.fix
          }}</span>
        </div>

        <div
          v-if="registerResult.error"
          role="alert"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-semibold text-destructive">{{ registerResult.error.message }}</span>
          <span v-if="registerResult.error.fix" class="text-muted-foreground">{{
            registerResult.error.fix
          }}</span>
        </div>

        <OutputView v-if="registerResult.rows" :output="registerResult.rows" />
      </TabsContent>

      <!-- --------------------------------------------- authenticate -->
      <TabsContent value="authenticate" class="flex flex-col gap-4 pt-4">
        <p class="max-w-[68ch] text-sm text-muted-foreground">
          Runs a sign in ceremony and decodes the assertion: the flags at signing time, the
          signature counter, the signature size, and the user handle.
        </p>

        <div
          v-if="support === 'no'"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-semibold">This browser has no WebAuthn support</span>
          <span class="text-muted-foreground">
            window.PublicKeyCredential is missing, so no passkey can be used here.
          </span>
        </div>

        <template v-else-if="support === 'yes'">
          <div class="flex flex-wrap items-center gap-2">
            <Button type="button" :disabled="busy !== null" @click="authenticate">
              <LogIn class="size-3.5" aria-hidden="true" />
              {{ busy === "authenticate" ? "Waiting for the authenticator…" : "Sign In" }}
            </Button>
            <Button v-if="authJson" type="button" variant="outline" @click="sendToDecode(authJson)">
              <ArrowRight class="size-3.5" aria-hidden="true" />
              Open in Decode
            </Button>
          </div>

          <p class="text-xs text-muted-foreground">
            <template v-if="credentialId">
              This asks for the passkey created in this session, credential ID
              <span class="font-mono break-all">{{ credentialId }}</span
              >.
            </template>
            <template v-else>
              No passkey has been created in this session, so this asks for any discoverable passkey
              already stored for {{ hostname }}. If there is none, the authenticator will say so.
            </template>
          </p>
        </template>

        <div
          v-if="authError"
          role="alert"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-semibold text-destructive">{{ authError.message }}</span>
          <span v-if="authError.fix" class="text-muted-foreground">{{ authError.fix }}</span>
        </div>

        <div
          v-if="authResult.error"
          role="alert"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-semibold text-destructive">{{ authResult.error.message }}</span>
          <span v-if="authResult.error.fix" class="text-muted-foreground">{{
            authResult.error.fix
          }}</span>
        </div>

        <OutputView v-if="authResult.rows" :output="authResult.rows" />
      </TabsContent>

      <!-- --------------------------------------------------- decode -->
      <TabsContent value="decode" class="flex flex-col gap-4 pt-4">
        <div class="flex flex-col gap-1.5">
          <Label for="pk-decode" class="text-xs text-muted-foreground">Credential to decode</Label>
          <Textarea
            id="pk-decode"
            v-model="decodeInput"
            rows="8"
            spellcheck="false"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            class="font-mono"
            placeholder="Paste a base64url attestationObject, raw authenticatorData, or the whole credential JSON"
          />
        </div>

        <div class="sm:max-w-64">
          <OptionControl v-if="viewSpec" v-model="opts.view" :spec="viewSpec" />
        </div>

        <div
          v-if="decodeResult.error"
          role="alert"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-semibold text-destructive">{{ decodeResult.error.message }}</span>
          <span v-if="decodeResult.error.fix" class="text-muted-foreground">{{
            decodeResult.error.fix
          }}</span>
        </div>

        <OutputView v-if="decodeResult.rows" :output="decodeResult.rows" />

        <p v-else-if="!decodeResult.error" class="text-xs text-muted-foreground">
          Paste a value above, or run a ceremony on the Register or Authenticate tab and press Open
          in Decode. This detail level also applies to the rows those tabs show.
        </p>
      </TabsContent>
    </Tabs>

    <p class="max-w-[68ch] text-xs text-muted-foreground">
      Passkeys created here are throwaway test entries. They stay registered with your password
      manager or device until you remove them, so you may want to delete the {{ hostname }} entry
      when you are finished. Everything on this page happens between your browser and your
      authenticator: your files and inputs never leave your device.
    </p>
  </div>
</template>
