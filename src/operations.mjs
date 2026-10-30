export function readiness(db,config={}){
  const counts=(table,column)=>Object.fromEntries(db.prepare(`SELECT ${column} state,COUNT(*) n FROM ${table} GROUP BY ${column}`).all().map(r=>[r.state,r.n]));
  const lastBackup=db.prepare("SELECT value FROM settings WHERE key='operations.last_backup_at'").get()?.value || null;
  const lastInbound=db.prepare('SELECT MAX(last_inbound) stamp FROM conversations').get().stamp;
  const lastDelivery=db.prepare("SELECT MAX(created_at) stamp FROM messages WHERE status IN('delivered','read') AND direction='out'").get().stamp;
  return {database:{integrity:db.prepare('PRAGMA quick_check').get().quick_check,foreign_key_errors:db.prepare('PRAGMA foreign_key_check').all().length,
    schema_version:db.prepare('SELECT MAX(version) version FROM schema_versions').get().version},
    backups:{last_at:lastBackup,age_hours:lastBackup?(Date.now()-Date.parse(lastBackup))/3600000:null},
    queues:{webhooks:counts('webhook_events','status'),messages:counts('messages','status'),media:counts('media_jobs','status'),automations:counts('automation_jobs','status')},
    whatsapp:{configuration_present:Boolean(config.accessToken&&config.phoneId&&config.appSecret&&config.verifyToken&&config.intakeUser),
      last_inbound_at:lastInbound,last_confirmed_delivery_created_at:lastDelivery,live_acceptance_verified:false},
    deployment:{public_hosting_verified:false},checked_at:new Date().toISOString()};
}
