import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.SWARMFORGE_DATA_DIR || path.join(__dirname, '../data'));
mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'swarmforge.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT,prompt TEXT,status TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,project_id TEXT,status TEXT,plan TEXT,report TEXT,error TEXT,created_at TEXT,updated_at TEXT);
CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,run_id TEXT,role TEXT,status TEXT,current_task TEXT,output TEXT,error TEXT,updated_at TEXT);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,run_id TEXT,agent_id TEXT,title TEXT,status TEXT,dependencies TEXT,output TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,project_id TEXT,path TEXT,content TEXT,updated_at TEXT,UNIQUE(project_id,path));
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT,agent_id TEXT,message TEXT,created_at TEXT);`);
const app = express(); app.use(cors()); app.use(express.json({limit:'2mb'}));
const agents = [
 ['orchestrator','Orchestrator Agent','Plans and coordinates the team, integration, gates and delivery.'],['analyst','Product Analyst','Requirements, user stories and acceptance criteria.'],['designer','UI/UX Designer','User flows, layouts and design system.'],['frontend','Frontend Developer','Responsive UI and API integration.'],['backend','Backend Developer','REST APIs, validation and business logic.'],['database','Database Engineer','Data model, migrations and integrity.'],['security','Security & Authentication Engineer','Authentication, authorization and security review.'],['qa','QA & Testing Engineer','Test strategy, test cases and verification.'],['devops','DevOps & Build Engineer','Local environment, scripts and deployment preparation.'],['reviewer','Code Reviewer','Integration, quality and security review.']
].map(([id,role,description])=>({id,role,description}));
let providerConfig = {baseUrl:'https://api.openai.com/v1',apiKey:'',model:'gpt-4o-mini',agentModels:{}};
const active = new Map();
const now=()=>new Date().toISOString(); const id=()=>crypto.randomUUID();
const parse=(s,fallback=null)=>{try{return JSON.parse(s)}catch{return fallback}};
const log=(run,agent,message)=>db.prepare('INSERT INTO logs(run_id,agent_id,message,created_at) VALUES(?,?,?,?)').run(run,agent,message,now());
const jsonRows=(query,...args)=>db.prepare(query).all(...args);
function safePath(p){ if(typeof p!=='string'||p.length>180||p.startsWith('/')||p.includes('\\')||p.split('/').some(x=>!x||x==='.'||x==='..')||!/^[-\w./]+$/.test(p)) throw Error('Unsafe or invalid workspace file path'); return p; }
async function callModel(agentId, system, prompt, signal){
 const key=providerConfig.apiKey; if(!key) throw Error('Configure an AI provider API key in Settings before starting a run.');
 const model=providerConfig.agentModels[agentId]||providerConfig.model;
 const base=providerConfig.baseUrl.replace(/\/$/,'');
 let response;
 for(let attempt=0;attempt<3;attempt++){
  response=await fetch(`${base}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({model,temperature:0.2,messages:[{role:'system',content:system},{role:'user',content:prompt}]}),signal});
  if(response.ok)break;
  if((response.status===429||response.status>=500)&&attempt<2){await new Promise(r=>setTimeout(r,600*(attempt+1)));continue;}
  const detail=(await response.text()).slice(0,500); throw Error(`Provider returned ${response.status}: ${detail}`);
 }
 const data=await response.json(); return {text:data.choices?.[0]?.message?.content||'',usage:data.usage||null,model};
}
function snapshot(projectId){return jsonRows('SELECT path,content,updated_at FROM files WHERE project_id=? ORDER BY path',projectId);}
function updateAgent(runId, agentId, status, task='', output=null, error=null){db.prepare('INSERT INTO agents(id,run_id,role,status,current_task,output,error,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,current_task=excluded.current_task,output=excluded.output,error=excluded.error,updated_at=excluded.updated_at').run(`${runId}:${agentId}`,runId,agentId,status,task,output,error,now());}
function updateTask(taskId,status,output=null,error=null){db.prepare('UPDATE tasks SET status=?,output=?,error=? WHERE id=?').run(status,output,error,taskId);}
function setRun(runId,status,report=null,error=null){db.prepare('UPDATE runs SET status=?,report=COALESCE(?,report),error=?,updated_at=? WHERE id=?').run(status,report,error,now(),runId);}
async function runAgent({runId,projectId,agent,task,signal}){
 const taskId=task.id; updateTask(taskId,'running');updateAgent(runId,agent.id,'Running',task.title);log(runId,agent.id,`Started: ${task.title}`);
 try{
  const existing=snapshot(projectId).map(f=>({path:f.path,content:f.content.slice(0,12000)}));
  const system=`You are ${agent.role} in SwarmForge AI, a real software engineering team. ${agent.description} Work only on your assigned task. Never claim tests or actions were executed unless supplied results prove it. Return ONLY valid JSON with keys: summary (string), files (array of {path,content}), findings (array of strings), next_steps (array of strings). Files must contain complete text, use relative safe paths. Do not overwrite another agent's files: choose distinct filenames/paths. Keep total response concise and implementation-ready. Do not include secrets.`;
  const result=await callModel(agent.id,system,`Project idea: ${db.prepare('SELECT prompt FROM projects WHERE id=?').get(projectId).prompt}\nTask: ${task.title}\nTask details: ${task.description}\nExisting workspace files (reference only): ${JSON.stringify(existing).slice(0,26000)}\nReturn structured JSON.`,signal);
  let body=result.text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''); const report=JSON.parse(body);
  if(!report||typeof report.summary!=='string'||!Array.isArray(report.files))throw Error('Agent response did not match required JSON report format.');
  const write=db.transaction(()=>{for(const f of report.files){const rel=safePath(f.path);if(typeof f.content!=='string'||f.content.length>250000)throw Error(`Invalid or oversized file: ${rel}`);const prior=db.prepare('SELECT content FROM files WHERE project_id=? AND path=?').get(projectId,rel);if(prior&&prior.content!==f.content)throw Error(`File conflict: ${rel} already exists. Agent output was rejected to protect existing work.`);db.prepare('INSERT OR IGNORE INTO files(id,project_id,path,content,updated_at) VALUES(?,?,?,?,?)').run(id(),projectId,rel,f.content,now());}});write();
  updateTask(taskId,'completed',JSON.stringify(report));updateAgent(runId,agent.id,'Completed',task.title,JSON.stringify(report));log(runId,agent.id,`Completed: ${report.summary} (${report.files.length} file(s) proposed)`);return report;
 }catch(e){const message=e.name==='AbortError'?'Run cancelled':String(e.message||e);updateTask(taskId,'failed',null,message);updateAgent(runId,agent.id,'Failed',task.title,null,message);log(runId,agent.id,`Failed: ${message}`);throw e;}
}
const descriptions={analyst:'Analyze requirements; produce spec/requirements.md with functional and non-functional requirements, stories, acceptance criteria, assumptions and risks.',designer:'Create user journeys and responsive UI specifications; produce design/ux-spec.md including screens, navigation, states and visual system.',database:'Design schema and migrations consistent with the requirements; produce database/schema.sql and database/data-model.md.',backend:'Define and implement API contracts and backend source skeleton appropriate for the app; include validation and errors. Avoid secrets.',frontend:'Build frontend components/pages with realistic accessible interactions, loading/error/empty states; choose distinct src/client/ paths.',security:'Review proposed architecture and document concrete auth, authorization, input validation, data protection and threat controls in security/security-review.md.',devops:'Create local setup scripts/config guidance and deployment preparation; produce README.md or ops/ files (avoid overwriting existing files).',qa:'Create executable test files and test plan, and clearly distinguish authored tests from executed tests. Produce tests/ and qa/test-plan.md.',reviewer:'Review all workspace artifacts for inconsistencies, security risks, missing integration, and quality. Produce review/review-report.md with pass/block verdict and actionable findings.'};
const deps={analyst:[],designer:['analyst'],database:['analyst'],backend:['analyst','database'],frontend:['analyst','designer'],security:['backend','database'],devops:['backend','frontend'],qa:['frontend','backend','database','security','devops'],reviewer:['qa']};
async function executeRun(runId){const run=db.prepare('SELECT * FROM runs WHERE id=?').get(runId);if(!run)return;const controller=new AbortController();active.set(runId,controller);try{
 setRun(runId,'planning');updateAgent(runId,'orchestrator','Running','Create development plan');log(runId,'orchestrator','Planning started');
 const planResult=await callModel('orchestrator','You are the Orchestrator Agent. Create a compact practical architecture and delivery plan. Return only JSON with keys architecture, milestones (array), risks (array), acceptance_criteria (array).',`User project request: ${db.prepare('SELECT prompt FROM projects WHERE id=?').get(run.project_id).prompt}`,controller.signal);
 let plan=JSON.parse(planResult.text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')); db.prepare('UPDATE runs SET plan=?,status=?,updated_at=? WHERE id=?').run(JSON.stringify(plan),'running',now(),runId);updateAgent(runId,'orchestrator','Completed','Development plan',JSON.stringify(plan));log(runId,'orchestrator','Plan created; specialist task graph initialized.');
 const taskMap={};const insert=db.prepare('INSERT INTO tasks(id,run_id,agent_id,title,status,dependencies) VALUES(?,?,?,?,?,?)');
 for(const a of agents.filter(x=>x.id!=='orchestrator')){const tid=id();taskMap[a.id]=tid;insert.run(tid,runId,a.id,descriptions[a.id],'pending',JSON.stringify(deps[a.id]));updateAgent(runId,a.id,'Idle',descriptions[a.id]);}
 const completed=new Set();let pending=agents.filter(a=>a.id!=='orchestrator');
 while(pending.length){if(controller.signal.aborted)throw Error('Run cancelled');const ready=pending.filter(a=>deps[a.id].every(d=>completed.has(d)));if(!ready.length)throw Error('Task dependency graph is blocked.');const batch=ready.slice(0,3); const results=await Promise.allSettled(batch.map(a=>runAgent({runId,projectId:run.project_id,agent:a,task:{id:taskMap[a.id],title:descriptions[a.id],description:descriptions[a.id]},signal:controller.signal})));for(let i=0;i<batch.length;i++){const a=batch[i];const r=results[i];if(r.status==='fulfilled'){completed.add(a.id);pending=pending.filter(p=>p.id!==a.id);}else if(a.id==='reviewer'||a.id==='qa'){pending=pending.filter(p=>p.id!==a.id);log(runId,'orchestrator',`${a.role} failed; review gate cannot pass.`);}}
  if(results.some((r,i)=>r.status==='rejected'&&['analyst','backend','frontend','database'].includes(batch[i].id)))throw Error('A critical development task failed. Check task and agent reports before retrying.');
 }
 const taskRows=jsonRows('SELECT agent_id,status,error FROM tasks WHERE run_id=?',runId);const files=snapshot(run.project_id);const review=taskRows.find(t=>t.agent_id==='reviewer'&&t.status==='completed');const verdict=review?parse(review.error||'{}'):null;
 const report={status:'completed',summary:'All runnable workflow tasks have finished. The reviewer output and test artifacts are in the workspace; tests are authored but not executed by this service.',files:files.map(f=>f.path),task_status:taskRows,review_required:true,tests_executed:false};setRun(runId,'completed',JSON.stringify(report),null);updateAgent(runId,'orchestrator','Completed','Final delivery gate',JSON.stringify(report));log(runId,'orchestrator','Run completed. No untrusted project code was executed.');
 }catch(e){const message=String(e.message||e);setRun(runId,message==='Run cancelled'?'cancelled':'failed',null,message);updateAgent(runId,'orchestrator',message==='Run cancelled'?'Failed':'Failed','Run coordination',null,message);log(runId,'orchestrator',`Run stopped: ${message}`);}finally{active.delete(runId);}}
app.get('/api/health',(_req,res)=>res.json({ok:true,agents:agents.length,execution:'disabled'}));
app.get('/api/agents',(_req,res)=>res.json(agents));
app.get('/api/config',(_req,res)=>res.json({configured:!!providerConfig.apiKey,baseUrl:providerConfig.baseUrl,model:providerConfig.model,agentModels:providerConfig.agentModels}));
app.put('/api/config',(req,res)=>{const {baseUrl,apiKey,model,agentModels}=req.body||{};if(baseUrl&&!/^https?:\/\//i.test(baseUrl))return res.status(400).json({error:'Provider URL must use HTTP or HTTPS.'});if(model&&typeof model!=='string')return res.status(400).json({error:'Invalid model.'});providerConfig={...providerConfig,baseUrl:baseUrl||providerConfig.baseUrl,apiKey:apiKey===undefined?providerConfig.apiKey:apiKey,model:model||providerConfig.model,agentModels:agentModels||providerConfig.agentModels};res.json({configured:!!providerConfig.apiKey,baseUrl:providerConfig.baseUrl,model:providerConfig.model,agentModels:providerConfig.agentModels});});
app.get('/api/projects',(_req,res)=>res.json(jsonRows('SELECT * FROM projects ORDER BY created_at DESC')));
app.post('/api/projects',(req,res)=>{const {name,prompt}=req.body||{};if(typeof prompt!=='string'||prompt.trim().length<12)return res.status(400).json({error:'Enter a project idea of at least 12 characters.'});const pid=id();db.prepare('INSERT INTO projects(id,name,prompt,status,created_at) VALUES(?,?,?,?,?)').run(pid,(name||prompt.trim().slice(0,64)).slice(0,100),prompt.trim(),'created',now());res.status(201).json(db.prepare('SELECT * FROM projects WHERE id=?').get(pid));});
app.get('/api/projects/:id',(req,res)=>{const project=db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);if(!project)return res.status(404).json({error:'Project not found'});const runs=jsonRows('SELECT * FROM runs WHERE project_id=? ORDER BY created_at DESC',project.id);res.json({project,runs});});
app.post('/api/projects/:id/runs',(req,res)=>{const project=db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);if(!project)return res.status(404).json({error:'Project not found'});if(!providerConfig.apiKey)return res.status(400).json({error:'Configure a provider API key first.'});const rid=id();db.prepare('INSERT INTO runs(id,project_id,status,created_at,updated_at) VALUES(?,?,?,?,?)').run(rid,project.id,'queued',now(),now());db.prepare('UPDATE projects SET status=? WHERE id=?').run('running',project.id);res.status(202).json({id:rid,status:'queued'});setImmediate(()=>executeRun(rid));});
app.post('/api/runs/:id/cancel',(req,res)=>{const c=active.get(req.params.id);if(!c)return res.status(409).json({error:'Run is not currently active.'});c.abort();res.json({status:'cancellation_requested'});});
app.get('/api/runs/:id',(req,res)=>{const run=db.prepare('SELECT * FROM runs WHERE id=?').get(req.params.id);if(!run)return res.status(404).json({error:'Run not found'});res.json({...run,plan:parse(run.plan),report:parse(run.report),agents:jsonRows('SELECT * FROM agents WHERE run_id=? ORDER BY rowid',run.id),tasks:jsonRows('SELECT * FROM tasks WHERE run_id=? ORDER BY rowid',run.id),logs:jsonRows('SELECT * FROM logs WHERE run_id=? ORDER BY id DESC LIMIT 100',run.id).reverse()});});
app.get('/api/projects/:id/files',(req,res)=>{if(!db.prepare('SELECT id FROM projects WHERE id=?').get(req.params.id))return res.status(404).json({error:'Project not found'});res.json(snapshot(req.params.id));});
app.get('/api/projects/:id/files/*',(req,res)=>{const projectId=req.params.id;const p=req.params[0];try{safePath(p)}catch(e){return res.status(400).json({error:e.message})}const f=db.prepare('SELECT path,content,updated_at FROM files WHERE project_id=? AND path=?').get(projectId,p);if(!f)return res.status(404).json({error:'File not found'});res.json(f);});
app.get('/api/projects/:id/logs',(_req,res)=>res.json([]));
app.get('/api/provider-models',async(_req,res)=>{if(!providerConfig.apiKey)return res.status(400).json({error:'Configure provider key first.'});try{const r=await fetch(`${providerConfig.baseUrl.replace(/\/$/,'')}/models`,{headers:{Authorization:`Bearer ${providerConfig.apiKey}`}});if(!r.ok)return res.status(r.status).json({error:`Provider returned ${r.status}`});const d=await r.json();res.json((d.data||[]).map(x=>x.id));}catch(e){res.status(502).json({error:String(e.message||e)})}});
app.use(express.static(path.resolve(__dirname,'../dist')));app.get('*',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'API route not found'});res.sendFile(path.resolve(__dirname,'../dist/index.html'));});
const port=Number(process.env.PORT||3001);app.listen(port,()=>console.log(`SwarmForge API listening on http://localhost:${port}`));
