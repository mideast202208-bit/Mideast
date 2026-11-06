# Independent daily encrypted backups

The web service's existing 30-second backup tick now creates a consistent `.mebak`
archive when the 24-hour interval is due and uploads that archive to the configured
private Google Drive folder. It runs on the hosted service independently of ChatGPT.
There is no additional paid cron service and no dependency on a ChatGPT connector
session or a copied browser access token.

Production activation requires checking the current Render environment, not only
editing `render.yaml`. Existing Blueprint services do not prompt for newly added
`sync: false` entries. Keep existing secrets intact; configure them securely in the
service's secret settings without printing their values:

- `BACKUP_INTERVAL_HOURS=24`
- `BACKUP_OFFSITE_ENABLED=1`
- existing `BACKUP_PUBLIC_KEY`, `BACKUP_DIR`, `BACKUP_SOURCE_ROOT`
- `DRIVE_FOLDER_ID` for the approved private backup folder
- a server-owned OAuth `DRIVE_CLIENT_ID`, `DRIVE_CLIENT_SECRET`, `DRIVE_REFRESH_TOKEN`

The Google Drive connector's signed-in session is not server OAuth configuration.
Do not extract access tokens from another app or browser. If the server is not
already connected, use the provider's normal authorization process. Preserve the
existing recovery key pair: do not replace it to fix scheduling. The private
recovery key remains offline with the owner.

Failed uploads retain the encrypted local archive and retry no more than once per
hour. A failed or incomplete upload does not update the successful offsite time.
The uploader checks the private folder, local SHA256, uploaded size and Google's
MD5 checksum, and writes SHA256 in both the file description and app properties.
The UI separates configuration from the last confirmed successful upload.

After deployment and configuration, verify a newly created Drive file, actual size,
timestamp and SHA256. Only then report the daily job as active. The existing daily
Drive check remains a separate monitor; it does not create backups.

Validation uses only synthetic records/credentials and real encrypted test archives.
No production backup or live activation is implied by passing the tests or merging
this change. A separate restoration drill is still needed to verify recovery.
