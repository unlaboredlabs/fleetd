// Administration › Google's guide (google/AdminGoogle.tsx, google/AdminMail.tsx): the steps in Google Cloud Console for
// the hub's OAuth client, with google_get's scopes and redirect, and for Gmail in real time. The hub's setup step for
// Google (hub/setup) gives the same parts and sends the admin here to save what comes back.

import type { GuidePart } from "../setup/Guide";
import { REDIRECT, SCOPES, scopeFor, scopeLabel } from "./model";

/**
 * Gmail in real time (D195, #743): Gmail publishes to this topic as its push account, and one machine reads the
 * subscription as this service account, with the Pub/Sub scope. The names google.md gives them.
 */
export const GMAIL_TOPIC = "fleetd-gmail";
export const GMAIL_SUBSCRIPTION = "fleetd-gmail-hub";
const GMAIL_READER = "fleetd-gmail-reader";
const GMAIL_PUSH = "gmail-api-push@system.gserviceaccount.com";

/** The Cloud project the guide names for a hub: `fleetd-<host>`. */
export const cloudProject = (hub: string): string => `fleetd-${new URL(hub.replace(/\/+$/u, "")).hostname.split(".")[0] ?? "hub"}`;

/**
 * The Google step's required parts, for this hub: the Cloud project, the APIs, the sign-in screen with the exact scopes
 * the hub asks for, and a Desktop app client with the loopback redirect. Administration › Google shows the same ones,
 * with google_get's scopes and redirect.
 */
export const googleParts = (hub: string, scopes: ReadonlyArray<string> = SCOPES, redirect: string = REDIRECT): ReadonlyArray<GuidePart> => {
  const host = new URL(hub.replace(/\/+$/u, "")).hostname.split(".")[0] ?? "hub";
  const name = `fleetd on ${host}`;
  return [
    {
      title: "Create a Google Cloud project",
      links: [{ label: "New project", url: "https://console.cloud.google.com/projectcreate" }],
      values: [{ label: "Project name", value: `fleetd-${host}`, note: "Keep the project ID the same as the name." }],
    },
    {
      title: "Turn on Gmail, Calendar and Drive",
      links: [
        {
          label: "Enable the three APIs",
          url: "https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com",
        },
      ],
    },
    {
      title: "Set up the sign-in screen",
      links: [
        { label: "Branding", url: "https://console.cloud.google.com/auth/branding" },
        { label: "Audience", url: "https://console.cloud.google.com/auth/audience" },
      ],
      values: [
        { label: "App name", value: name },
        { label: "Audience", value: "Internal if everyone is in your Google Workspace; otherwise External.", plain: true },
        {
          label: "Publishing status",
          value: "External: press Publish app, so it is In production. In Testing, Google ends each connection after 7 days.",
          plain: true,
        },
      ],
    },
    {
      title: "Add the scopes",
      note: "Gmail and Drive are restricted scopes: until Google verifies the app, people see a warning when they connect and press Advanced, then Go to the app. An unverified app takes up to 100 people.",
      links: [{ label: "Data access", url: "https://console.cloud.google.com/auth/scopes" }],
      values: scopes.map((s) => ({ label: scopeLabel(s), value: s, note: scopeFor(s) })),
    },
    {
      title: "Create the OAuth client",
      links: [{ label: "Create client", url: "https://console.cloud.google.com/auth/clients/create" }],
      values: [
        { label: "Application type", value: "Desktop app", plain: true },
        { label: "Name", value: name },
        {
          label: "Redirect URI",
          value: redirect,
          note: "Nothing to register: a Desktop app client takes it on any port. When someone connects, the fleetd app listens on a free port on their own computer, and Google sends them back there.",
        },
      ],
    },
  ];
};

/**
 * Real-time mail's parts, both optional: the topic Gmail tells and its subscription, then a service account that may
 * only read it, with its key. Administration › Google shows the same ones above its fields.
 */
export const realtimeParts = (hub: string): ReadonlyArray<GuidePart> => {
  const project = cloudProject(hub);
  return [
    {
      title: "Gmail in real time",
      optional: true,
      note: "New mail reaches Navi in seconds. Gmail publishes to a Pub/Sub topic and fleetd pulls from it, so no public address is needed. Without it, Navi checks Gmail about every minute.",
      links: [
        { label: "Enable Pub/Sub", url: "https://console.cloud.google.com/flows/enableapi?apiid=pubsub.googleapis.com" },
        { label: "Create the topic", url: "https://console.cloud.google.com/cloudpubsub/topic/create" },
        { label: "Create the subscription", url: "https://console.cloud.google.com/cloudpubsub/subscription/create" },
      ],
      values: [
        { label: "Topic ID", value: GMAIL_TOPIC, note: `Untick "Add a default subscription". Its full name is projects/${project}/topics/${GMAIL_TOPIC}.` },
        { label: "Publisher on the topic", value: GMAIL_PUSH, note: "Topic › Permissions › Add principal, role Pub/Sub Publisher. Gmail publishes as this account." },
        { label: "Subscription ID", value: GMAIL_SUBSCRIPTION, note: `Topic ${GMAIL_TOPIC}, delivery type Pull. Its full name is projects/${project}/subscriptions/${GMAIL_SUBSCRIPTION}.` },
      ],
    },
    {
      title: "A key to read it",
      optional: true,
      note: "A service account that may only read the subscription. Its key goes to one machine, which pulls new-mail notices and passes them to the hub.",
      links: [
        { label: "Create the service account", url: "https://console.cloud.google.com/iam-admin/serviceaccounts/create" },
        { label: "Subscriptions", url: "https://console.cloud.google.com/cloudpubsub/subscription/list" },
        { label: "Service accounts", url: "https://console.cloud.google.com/iam-admin/serviceaccounts" },
      ],
      values: [
        { label: "Service account ID", value: GMAIL_READER, note: "No project roles: skip the optional steps and press Done." },
        {
          label: "Subscriber on the subscription",
          value: `${GMAIL_READER}@${project}.iam.gserviceaccount.com`,
          note: "Subscriptions › the subscription above › Permissions › Add principal, role Pub/Sub Subscriber.",
        },
        { label: "Key", value: "Service accounts › the account above › Keys › Add key › Create new key › JSON. Paste the downloaded file into Service account key, then delete it.", plain: true },
        {
          label: "Or in Cloud Shell",
          value: [
            `gcloud config set project ${project}`,
            `SA=${GMAIL_READER}@${project}.iam.gserviceaccount.com`,
            [
              `gcloud services enable pubsub.googleapis.com`,
              `gcloud pubsub topics create ${GMAIL_TOPIC}`,
              `gcloud pubsub topics add-iam-policy-binding ${GMAIL_TOPIC} --member=serviceAccount:${GMAIL_PUSH} --role=roles/pubsub.publisher`,
              `gcloud pubsub subscriptions create ${GMAIL_SUBSCRIPTION} --topic=${GMAIL_TOPIC}`,
              `gcloud iam service-accounts create ${GMAIL_READER}`,
              `sleep 30`,
              `gcloud pubsub subscriptions add-iam-policy-binding ${GMAIL_SUBSCRIPTION} --member=serviceAccount:$SA --role=roles/pubsub.subscriber`,
              `gcloud iam service-accounts keys create key.json --iam-account=$SA`,
              `cat key.json && rm key.json`,
            ].join(" &&\n"),
          ].join("\n"),
          note: `Both parts in one go, in project ${project}: it prints the key once, to paste into Service account key. A new account can take a minute to show up; if the Subscriber grant says it doesn't exist, run the last three lines again.`,
        },
      ],
    },
  ];
};
