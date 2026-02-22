<div align="center">

# 🍃 Mongolite CLI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Powerful colorful CLI for MongoDB: databases, users, roles, collections, dump/import – Local, VPS & Atlas.

</div>

## ✨ Features
- 🎨 Colorized output
- 🗄️ Create / list / delete databases + existence check
- 👥 Create users, change passwords, reset roles
- 🎯 One-command bootstrap (`setup`)
- 🔑 Role assignment via names or numeric codes
- 📦 List & delete collections
- 💾 Dump/import single or all databases
- 📬 Discord webhook backup uploader with scheduler (every 4h by default), zipped backups + storage/decrease report
- 🌐 Atlas / VPS / Local connection support
- 🔐 Auth & authSource handling
- 🔧 Connection and user auth testing
- 🛡️ Special character password support (quoted)
- 📊 Extended predefined role map
- 🚀 Global binaries: `mongocli`, `mongolite`, `mongolite-cli`
- ⚙️ `.env` or full URI configuration
- 🧪 Placeholder collection for new DB materialization
- 🧷 Minimal footprint, script-friendly
- 🌍 Cross‑platform

## 📦 Installation
```bash
git clone https://github.com/ismdevx/mongolite-cli.git
cd mongolite-cli
npm install
npm link
```
Global usage (aliases): `mongocli` | `mongolite` | `mongolite-cli`

## 🚀 Quick Start
```bash
cp .env.example .env
```
Edit `.env` (choose ONE method):

Atlas URI:
```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/?retryWrites=true&w=majority&appName=YourApp
```
Local / VPS variables:
```env
DB_HOST=localhost
DB_PORT=27017
ADMIN_USERNAME=admin
ADMIN_PASSWORD="myP@ssw0rd#with!special%chars"
AUTH_DB=admin
```
Create DB & user:
```bash
mongocli create-db myapp
mongocli create-user myapp appuser strong_password readWrite
```
List DBs / Help:
```bash
mongocli list-db
mongocli help
```

## 🖥️ VPS Setup
```bash
mongocli setup admin admin "your_secure_password" root
mongocli connection --host your-vps-ip --port 27017 --user admin
```
Special chars example:
```bash
mongocli setup admin admin "myP@ssw0rd#123!" root
```

## 🎯 Common Examples
```bash
mongocli setup myapp app_user "secure_pass123" readWrite
mongocli dump db production ./backup/
mongocli import db development ./backup/production --drop
mongocli create-user reporting report_user "report_pass" read
mongocli set-roles reporting report_user read,dbAdmin
mongocli backup-discord --once --out-dir ./mongodb-cli
```

## 📚 Commands
### Database
```bash
mongocli create-db <dbName> [collectionName]
mongocli list-db
mongocli delete-db <dbName>
mongocli db-exists <dbName>
```
### Users
```bash
mongocli create-user <dbName> <username> <password> [role1,role2,...]
mongocli setup <dbName> <username> <password> [role1,role2,...]
mongocli change-password <dbName> <username> <newPassword>
mongocli set-roles <dbName> <username> <role1,role2,...>
mongocli list-users <dbName>
mongocli all users
mongocli delete-user <dbName> <username>
mongocli auth-user <dbName> <username> <password>
```
### Collections
```bash
mongocli list-collections <dbName>
mongocli delete-collection <dbName> <collectionName>
```
### Import / Export
```bash
mongocli dump db <dbName> [outDir] [--include-system-collections]
mongocli dump all [outDir] [--include-system-dbs] [--include-system-collections]
mongocli import db <dbName> <dir> [--drop] [--upsert]
mongocli import all <rootDir> [--drop] [--upsert]
mongocli backup-discord [--once] [--db <dbName>] [--out-dir <dir>] [--interval-hours <n>] [--webhook <url>] [--max-file-mb <n>] [--include-system-dbs] [--include-system-collections]
```
### Discord Backup Scheduler
```bash
mongocli backup-discord
mongocli backup-discord --once
mongocli backup-discord --db mydb --interval-hours 4 --out-dir ./mongodb-cli
```
`backup-discord` runs one backup immediately, then continues every 4 hours by default.
It sends:
- one `.zip` backup file to the Discord channel webhook
- backup date/time, current DB storage, and decrease/increase info vs previous backup
- if zip is larger than your max upload size, it auto-splits and sends parts

Local metadata file:
- `./mongodb-cli/latest-backup-summary.json` (last run summary for delta comparison)

### Utility
```bash
mongocli connection --host <host> --port <port> --user <user>
mongocli use-db <dbName>
mongocli help
```

## 🔧 Configuration
Atlas URI (preferred for Atlas clusters):
```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/?retryWrites=true&w=majority&appName=YourApp
```
Individual variables (local/VPS):
```env
DB_HOST=localhost
DB_PORT=27017
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_password
AUTH_DB=admin
DISCORD_WEBHOOK_URL=
DISCORD_BACKUP_INTERVAL_HOURS=4
DISCORD_BACKUP_OUT_DIR=./mongodb-cli
DISCORD_BACKUP_DB=
DISCORD_BACKUP_INCLUDE_SYSTEM_DBS=false
DISCORD_BACKUP_INCLUDE_SYSTEM_COLLECTIONS=false
DISCORD_BACKUP_MAX_FILE_MB=8
```
| Variable | Default | Description |
|----------|---------|-------------|
| MONGODB_URI | - | Full connection string (overrides others) |
| DB_HOST | localhost | Hostname |
| DB_PORT | 27017 | Port |
| ADMIN_USERNAME | - | Admin username |
| ADMIN_PASSWORD | - | Admin password |
| AUTH_DB | admin | Authentication database |
| DISCORD_WEBHOOK_URL | - | Discord webhook target for backup uploads |
| DISCORD_BACKUP_INTERVAL_HOURS | 4 | Backup scheduler interval in hours |
| DISCORD_BACKUP_OUT_DIR | ./mongodb-cli | Local backup output directory |
| DISCORD_BACKUP_DB | - | Optional single database scope; empty = all databases |
| DISCORD_BACKUP_INCLUDE_SYSTEM_DBS | false | Include `admin`, `config`, `local` when dumping all DBs |
| DISCORD_BACKUP_INCLUDE_SYSTEM_COLLECTIONS | false | Include `system.*` collections |
| DISCORD_BACKUP_MAX_FILE_MB | 8 | Max upload size per file sent to Discord |

**⚠️ Password Special Characters:** If your password contains special characters (#, !, @, %, etc.), wrap it in quotes:
```env
ADMIN_PASSWORD="myP@ssw0rd#with!special%chars"
```
## MongoDB Roles
Database: `read`, `readWrite`, `dbAdmin`, `dbOwner`, `userAdmin`

Cluster: `readAnyDatabase`, `readWriteAnyDatabase`, `dbAdminAnyDatabase`, `userAdminAnyDatabase`, `clusterMonitor`, `clusterManager`, `clusterAdmin`

## 🔒 Security Considerations
1. Keep credentials in `.env`
2. Use strong unique passwords
3. Assign least privilege
4. Restrict network access / firewall appropriately

## 💡 Role Codes
| Code | Role |
|------|------|
| 1 | read |
| 2 | readWrite |
| 3 | dbAdmin |
| 4 | dbOwner |
| 5 | userAdmin |
| 6 | readAnyDatabase |
| 7 | readWriteAnyDatabase |
| 8 | dbAdminAnyDatabase |
| 9 | userAdminAnyDatabase |
| 10 | clusterMonitor |
| 11 | clusterManager |
| 12 | clusterAdmin |
| 13 | hostManager |
| 14 | backup |
| 15 | restore |
| 99 | root |


### Example:
```bash
mongocli create-user mydb appuser strong_password 2,3
mongocli set-roles mydb appuser 1
```

## 📝 Notes
- If admin creds set → authenticated connection automatically
- Placeholder `test` collection created for new DB visibility
- Passwords with special chars should be quoted in `.env`

## ⭐ Support
If this project helps you, please star it ⭐

## 🐛 Issues
Use GitHub Issues for bugs & feature requests.

## 📄 License
MIT License (see `LICENSE`).
