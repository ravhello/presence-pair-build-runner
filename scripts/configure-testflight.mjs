import { appendFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";

const API_ROOT = "https://api.appstoreconnect.apple.com/v1";
const APP_ID = required("ASC_APP_ID");
const BUILD_NUMBER = required("ASC_BUILD_NUMBER");
const GROUP_NAME = required("TESTFLIGHT_GROUP_NAME");
const TESTER_EMAIL = required("TESTFLIGHT_TESTER_EMAIL");
const KEY_ID = required("ASC_KEY_ID");
const ISSUER_ID = required("ASC_ISSUER_ID");
const PRIVATE_KEY = createPrivateKey(
  Buffer.from(required("ASC_PRIVATE_KEY_BASE64"), "base64"),
);
const DEADLINE = Date.now() + 20 * 60 * 1000;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "ES256", kid: KEY_ID, typ: "JWT" });
  const payload = encode({
    iss: ISSUER_ID,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: PRIVATE_KEY,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

async function request(path, options = {}) {
  const response = await fetch(path.startsWith("http") ? path : `${API_ROOT}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${options.method ?? "GET"} ${path}: ${response.status} ${body}`);
  }
  return response.status === 204 ? undefined : response.json();
}

async function list(path) {
  const items = [];
  let next = path;
  while (next) {
    const body = await request(next);
    items.push(...body.data);
    next = body.links?.next ?? null;
  }
  return items;
}

async function waitForBuild() {
  while (Date.now() < DEADLINE) {
    const builds = await list(
      `/builds?filter%5Bapp%5D=${APP_ID}&filter%5Bversion%5D=${encodeURIComponent(BUILD_NUMBER)}&limit=200`,
    );
    const build = builds.find((item) => item.attributes.version === BUILD_NUMBER);
    const state = build?.attributes.processingState;
    if (state === "VALID") return build;
    if (state === "FAILED" || state === "INVALID") {
      throw new Error(`Build ${BUILD_NUMBER} processing failed with state ${state}`);
    }
    console.log(`Build ${BUILD_NUMBER} is ${state ?? "not visible yet"}; waiting...`);
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
  throw new Error(`Build ${BUILD_NUMBER} was not ready within 20 minutes`);
}

const users = await list(
  `/users?filter%5Busername%5D=${encodeURIComponent(TESTER_EMAIL)}&limit=200`,
);
if (!users.length) {
  throw new Error("The configured tester is not an App Store Connect user");
}
console.log("Verified the internal App Store Connect tester");

const groups = await list(
  `/betaGroups?filter%5Bapp%5D=${APP_ID}&filter%5Bname%5D=${encodeURIComponent(GROUP_NAME)}&limit=200`,
);
let group = groups[0];
if (!group) {
  const created = await request("/betaGroups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: {
        type: "betaGroups",
        attributes: {
          name: GROUP_NAME,
          isInternalGroup: true,
          hasAccessToAllBuilds: false,
          publicLinkEnabled: false,
          feedbackEnabled: true,
        },
        relationships: { app: { data: { type: "apps", id: APP_ID } } },
      },
    }),
  });
  group = created.data;
  console.log("Created the internal TestFlight group");
} else if (group.attributes.isInternalGroup !== true) {
  throw new Error("The configured TestFlight group is not internal");
} else {
  console.log("Verified the internal TestFlight group");
}

const build = await waitForBuild();
const groupBuilds = await list(`/betaGroups/${group.id}/builds?limit=200`);
if (!groupBuilds.some((item) => item.id === build.id)) {
  await request(`/betaGroups/${group.id}/relationships/builds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [{ type: "builds", id: build.id }] }),
  });
  console.log(`Added build ${BUILD_NUMBER} to the internal TestFlight group`);
} else {
  console.log(`Verified build ${BUILD_NUMBER} in the internal TestFlight group`);
}

const testers = await list(
  `/betaTesters?filter%5Bemail%5D=${encodeURIComponent(TESTER_EMAIL)}&limit=200`,
);
let tester = testers[0];
if (!tester) {
  const created = await request("/betaTesters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: {
        type: "betaTesters",
        attributes: { email: TESTER_EMAIL },
        relationships: { betaGroups: { data: [{ type: "betaGroups", id: group.id }] } },
      },
    }),
  });
  tester = created.data;
  console.log("Added the configured internal tester");
} else {
  const testerGroups = await list(`/betaTesters/${tester.id}/betaGroups?limit=200`);
  if (!testerGroups.some((item) => item.id === group.id)) {
    await request(`/betaTesters/${tester.id}/relationships/betaGroups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [{ type: "betaGroups", id: group.id }] }),
    });
    console.log("Linked the configured tester to the internal group");
  } else {
    console.log("Verified the configured tester in the internal group");
  }
}

const verifiedBuilds = await list(`/betaGroups/${group.id}/builds?limit=200`);
const verifiedTesters = await list(`/betaGroups/${group.id}/betaTesters?limit=200`);
if (!verifiedBuilds.some((item) => item.id === build.id)) {
  throw new Error("The selected build is not linked to the TestFlight group");
}
if (!verifiedTesters.some((item) => item.id === tester.id)) {
  throw new Error("The tester is not linked to the TestFlight group");
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `build_id=${build.id}\n`);
}
console.log(`TestFlight is ready for build ${BUILD_NUMBER}`);
