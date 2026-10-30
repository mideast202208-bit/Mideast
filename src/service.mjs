import { randomUUID } from 'node:crypto';
import { transaction } from './db.mjs';
import { normalizePhone } from './security.mjs';
import { enqueueWorkflow } from './workflows.mjs';
import { listQuotes } from './sales.mjs';

export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export const manager = user => ['admin', 'manager'].includes(user.role);
export const finance = user => ['admin', 'manager', 'accountant'].includes(user.role);
export class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const fail = (status, message) => { throw new AppError(status, message); };
export function text(value, label, max = 200, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, `${label}: قيمة غير صالحة`);
  return value.trim();
}
export function audit(db, user, action, entity, id, metadata = {}) {
  db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)').run(uid(), user?.id || null, action, entity, id, JSON.stringify(metadata), now());
}
export function getContact(db, user, id) {
  const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
  if (!contact || (!manager(user) && contact.owner_id !== user.id)) fail(404, 'العميل غير موجود أو غير متاح');
  return contact;
}
export function owner(db, user, requested) {
  const target = requested || user.id;
  if (!manager(user) && target !== user.id) fail(403, 'إسناد الموظفين متاح للإدارة');
  const account = db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role IN('admin','manager','agent')").get(target);
  if (!account) fail(400, 'اختر موظفًا نشطًا لخدمة العملاء');
  return target;
}
export function validateCustom(db, entity, values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) fail(400, 'حقول الاستوديو غير صالحة');
  const fields = db.prepare('SELECT * FROM studio_fields WHERE entity=? ORDER BY position,rowid').all(entity);
  const known = new Set(fields.map(f => f.field_key));
  for (const key of Object.keys(values)) if (!known.has(key)) fail(400, `حقل غير معروف: ${key}`);
  const cleaned = Object.create(null);
  for (const field of fields) {
    const value = values[field.field_key];
    if (value === undefined || value === null || value === '') {
      if (field.required) fail(400, `الحقل مطلوب: ${field.label}`);
      continue;
    }
    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(400, `رقم غير صالح: ${field.label}`);
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') fail(400, `قيمة اختيار غير صالحة: ${field.label}`);
    } else {
      if (typeof value !== 'string' || value.length > 2000) fail(400, `قيمة غير صالحة: ${field.label}`);
      if (field.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) fail(400, `تاريخ غير صالح: ${field.label}`);
      if (field.type === 'select' && !JSON.parse(field.options).includes(value)) fail(400, `اختيار غير متاح: ${field.label}`);
    }
    cleaned[field.field_key] = value;
  }
  return JSON.stringify(cleaned);
}
export function runAutomations(db, trigger, record, eventId) {
  const contact=db.prepare('SELECT name,source FROM contacts WHERE id=?').get(record.contact_id||record.id);
  record={...contact,...record};
  const rules = db.prepare('SELECT * FROM automations WHERE active=1 AND trigger=?').all(trigger);
  for (const rule of rules) {
    if (rule.condition_stage && rule.condition_stage !== record.stage) continue;
    if(JSON.parse(rule.actions || '[]').length){enqueueWorkflow(db,rule,trigger,record,eventId);continue;}
    if (db.prepare('SELECT 1 FROM automation_runs WHERE rule_id=? AND event_id=?').get(rule.id, eventId)) continue;
    const taskId = uid();
    db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run(taskId, record.contact_id || record.id,
      record.lead_id || (trigger.startsWith('lead.') ? record.id : null), rule.task_title,
      new Date(Date.now() + rule.due_hours * 3600000).toISOString(), 'open', record.owner_id, now());
    db.prepare('INSERT INTO automation_runs VALUES(?,?,?)').run(rule.id, eventId, taskId);
  }
}
export function createContact(db, user, input, { source = 'manual' } = {}) {
  if (user.role === 'accountant') fail(403, 'لا تملك صلاحية إنشاء عميل');
  const record = { id: uid(), name: text(input.name, 'الاسم'), phone: input.phone ? normalizePhone(input.phone) : null,
    email: text(input.email || '', 'البريد', 254, false), owner_id: owner(db, user, input.owner_id),
    custom: validateCustom(db, 'contact', input.custom), created_at: now() };
  if (record.phone && db.prepare('SELECT id FROM contacts WHERE phone=?').get(record.phone)) fail(409, 'الرقم مسجل بالفعل؛ راجع جهة الاتصال الموجودة');
  transaction(db, () => {
    db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?,?,?,?,?)').run(record.id, record.name, record.phone, record.email,
      source, record.owner_id, record.custom, record.created_at, record.created_at);
    runAutomations(db, 'contact.created', record, record.id);
    audit(db, user, 'created', 'contact', record.id);
  });
  return record;
}
export function createLead(db, user, input) {
  if (user.role === 'accountant') fail(403, 'صلاحية CRM غير متاحة');
  const contact = getContact(db, user, input.contact_id);
  const value = input.value_minor ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) fail(400, 'القيمة المالية بالقرش يجب أن تكون رقمًا صحيحًا موجبًا أو صفرًا');
  const record = { id: uid(), contact_id: contact.id, title: text(input.title, 'عنوان الفرصة'),
    owner_id: contact.owner_id, custom: validateCustom(db, 'lead', input.custom), stage: 'new' };
  transaction(db, () => {
    db.prepare('INSERT INTO leads VALUES(?,?,?,?,?,?,?,?,?)').run(record.id, record.contact_id, record.title, 'new', value,
      record.owner_id, record.custom, now(), now());
    runAutomations(db, 'lead.created', record, record.id); audit(db, user, 'created', 'lead', record.id);
  });
  return record;
}
export function getData(db, user) {
  const scope = manager(user) ? '' : ' WHERE owner_id=?';
  const args = manager(user) ? [] : [user.id];
  const contacts = db.prepare('SELECT c.*,COALESCE(p.whatsapp_opt_in,0) AS whatsapp_opt_in FROM contacts c LEFT JOIN contact_preferences p ON p.contact_id=c.id' + (manager(user)?'':' WHERE c.owner_id=?') + ' ORDER BY c.created_at DESC').all(...args);
  const leads = user.role === 'accountant' ? [] : db.prepare('SELECT * FROM leads' + scope + ' ORDER BY updated_at DESC').all(...args);
  const tasks = user.role === 'accountant' ? [] : db.prepare('SELECT * FROM tasks' + scope + ' ORDER BY due_at').all(...args);
  const tickets = user.role === 'accountant' ? [] : db.prepare('SELECT * FROM tickets' + scope + ' ORDER BY updated_at DESC').all(...args);
  const conversations = user.role === 'accountant' ? [] : db.prepare(`SELECT v.*,c.name,c.phone,c.owner_id,
    (SELECT body FROM messages m WHERE m.conversation_id=v.id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS preview
    FROM conversations v JOIN contacts c ON c.id=v.contact_id ${manager(user) ? '' : 'WHERE c.owner_id=?'}
    ORDER BY COALESCE(v.last_inbound,v.created_at) DESC`).all(...args);
  const fields = db.prepare('SELECT * FROM studio_fields ORDER BY position,rowid').all();
  const automations = manager(user) ? db.prepare('SELECT * FROM automations ORDER BY created_at').all() : [];
  const users = manager(user) ? db.prepare('SELECT id,name,email,role,active FROM users ORDER BY name').all() : [{id:user.id,name:user.name,role:user.role}];
  const invoices = finance(user) ? db.prepare(`SELECT i.*,c.name AS contact_name,
    COALESCE((SELECT SUM(p.amount_minor) FROM payments p WHERE p.invoice_id=i.id),0) AS paid_minor
    FROM invoices i JOIN contacts c ON c.id=i.contact_id ORDER BY i.created_at DESC`).all() : [];
  const invoiceContacts = user.role === 'accountant' ? db.prepare('SELECT id,name FROM contacts ORDER BY name').all() : [];
  const settings = Object.fromEntries(db.prepare("SELECT key,value FROM settings WHERE key IN('company_name','currency')").all().map(r => [r.key,r.value]));
  const apps=user.role==='accountant'?[]:db.prepare('SELECT * FROM studio_apps ORDER BY created_at').all();
  const appFields=user.role==='accountant'?[]:db.prepare('SELECT * FROM app_fields ORDER BY position,rowid').all();
  const appRecords=user.role==='accountant'?[]:db.prepare('SELECT * FROM app_records'+scope+' ORDER BY updated_at DESC').all(...args);
  const pipeline=db.prepare('SELECT * FROM pipeline_stages ORDER BY position').all();
  const templates=user.role==='accountant'?[]:db.prepare('SELECT * FROM wa_templates ORDER BY name,language').all();
  const quotes=listQuotes(db,user);
  return {contacts,leads,tasks,tickets,conversations,fields,automations,users,invoices,invoiceContacts,settings,apps,appFields,appRecords,pipeline,templates,quotes};
}
