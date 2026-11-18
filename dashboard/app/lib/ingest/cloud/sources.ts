/**
 * Cloud push integrations (BAC-99): the cloud logging services that push to backwork with no
 * install and no cloud credentials kept by backwork, their endpoint paths and the setup steps the
 * Projects page shows (console and CLI). Client-safe; the parsers are in ./<source>.server.ts.
 */
import { TOKEN_PLACEHOLDER, type DrainStep } from "~/lib/ingest/drains/platforms";

export const CloudSource = { AwsFirehose: "aws", GcpPubSub: "gcp" } as const;
export type CloudSource = (typeof CloudSource)[keyof typeof CloudSource];

export const FIREHOSE_PATH = "/ingest/cloud/aws/firehose";
/** Ingest tokens are `bw_` + hex, safe in a path as they are. */
export function gcpPushPath(token: string): string {
  return `/ingest/cloud/gcp/${token}`;
}

export interface CloudGuide {
  source: CloudSource;
  label: string;
  naming: string;
  console: DrainStep[];
  cli: DrainStep[];
}

/** Setup for both clouds, for a backwork at BASE_URL and an ingest token (or the placeholder). */
export function cloudGuides(baseUrl: string, token: string = TOKEN_PLACEHOLDER): CloudGuide[] {
  const base = baseUrl.replace(/\/+$/, "");
  const firehose = `${base}${FIREHOSE_PATH}`;
  const push = `${base}${gcpPushPath(token)}`;
  return [
    {
      source: CloudSource.AwsFirehose,
      label: "AWS CloudWatch",
      naming: "Service is the log group's last part (the function for /aws/lambda/<fn>), or the stream's service attribute; host is the log stream's last part.",
      console: [
        { text: "Amazon Data Firehose → Create Firehose stream. Source: Direct PUT. Destination: HTTP Endpoint. HTTP endpoint URL:", copy: firehose },
        { text: "Access key (sent as X-Amz-Firehose-Access-Key):", copy: token },
        { text: "Content encoding: GZIP. Buffer hints: 1 MiB, 60 seconds. Optional parameter service = my-api names the service for every log group. S3 backup: failed data only." },
        { text: "CloudWatch → Log groups → your group → Subscription filters → Create Amazon Data Firehose subscription filter → the stream above, with a role CloudWatch Logs can assume (firehose:PutRecord on the stream)." },
      ],
      cli: [
        {
          text: "Create the stream (an S3 bucket for failed batches and a role Firehose can assume are required by AWS):",
          copy:
            `aws firehose create-delivery-stream --delivery-stream-name backwork \\\n` +
            `  --http-endpoint-destination-configuration '{\n` +
            `    "EndpointConfiguration": { "Url": "${firehose}", "Name": "backwork", "AccessKey": "${token}" },\n` +
            `    "RequestConfiguration": { "ContentEncoding": "GZIP" },\n` +
            `    "BufferingHints": { "SizeInMBs": 1, "IntervalInSeconds": 60 },\n` +
            `    "S3BackupMode": "FailedDataOnly",\n` +
            `    "S3Configuration": { "RoleARN": "arn:aws:iam::<ACCOUNT>:role/FirehoseToS3", "BucketARN": "arn:aws:s3:::<BUCKET>" },\n` +
            `    "RoleARN": "arn:aws:iam::<ACCOUNT>:role/FirehoseToS3" }'`,
        },
        {
          text: "Subscribe a log group (the role lets logs.amazonaws.com call firehose:PutRecord):",
          copy:
            `aws logs put-subscription-filter --log-group-name /aws/lambda/my-fn --filter-name backwork \\\n` +
            `  --filter-pattern "" \\\n` +
            `  --destination-arn arn:aws:firehose:<REGION>:<ACCOUNT>:deliverystream/backwork \\\n` +
            `  --role-arn arn:aws:iam::<ACCOUNT>:role/CWLtoFirehose`,
        },
      ],
    },
    {
      source: CloudSource.GcpPubSub,
      label: "Google Cloud Logging",
      naming: "Service is the Cloud Run service or job, function, App Engine service or GKE container; host is the instance, pod or revision.",
      console: [
        { text: "Pub/Sub → Create topic backwork-logs." },
        { text: "Logging → Log Router → Create sink → Cloud Pub/Sub topic → backwork-logs, with a filter for the logs to send. Give the sink's writer identity Pub/Sub Publisher on the topic." },
        { text: "Pub/Sub → Subscriptions → Create → topic backwork-logs, delivery type Push, endpoint URL (the token is in the path: a push subscription cannot set headers):", copy: push },
        { text: "Acknowledgement deadline 60 s. Authentication is optional; backwork does not need it." },
      ],
      cli: [
        {
          text: "Topic, sink, publisher grant and push subscription:",
          copy:
            `gcloud pubsub topics create backwork-logs\n` +
            `gcloud logging sinks create backwork pubsub.googleapis.com/projects/$PROJECT/topics/backwork-logs \\\n` +
            `  --log-filter='resource.type="cloud_run_revision"'\n` +
            `gcloud pubsub topics add-iam-policy-binding backwork-logs --role=roles/pubsub.publisher \\\n` +
            `  --member="$(gcloud logging sinks describe backwork --format='value(writerIdentity)')"\n` +
            `gcloud pubsub subscriptions create backwork-push --topic=backwork-logs --ack-deadline=60 \\\n` +
            `  --push-endpoint="${push}"`,
        },
      ],
    },
  ];
}
