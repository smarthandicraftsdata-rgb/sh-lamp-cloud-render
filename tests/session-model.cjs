// In-memory transaction model for host regression only. Real database locking
// and migration are validated by session.test.cjs against PostgreSQL in CI.
const crypto=require('node:crypto');
module.exports=function install(prisma){
 let tables={user:[],refreshToken:[],authSession:[]},queue=Promise.resolve();
 const matches=(row,where={})=>Object.entries(where).every(([k,v])=>{
  if(v && typeof v==='object' && !(v instanceof Date)){
   if('in' in v)return v.in.includes(row[k]);
   if('not' in v)return row[k]!==v.not;
   if('gt' in v)return row[k]>v.gt;
   if('lte' in v)return row[k]<=v.lte;
  }return row[k]===v;
 });
 function client(data){const out={};
  for(const table of Object.keys(data))out[table]={
   async create({data:input}){const row={id:crypto.randomUUID(),createdAt:new Date(),revokedAt:null,sessionId:null,replacementId:null,retryUntil:null,retryCiphertext:null,...input};data[table].push(row);return structuredClone(row);},
   async findUnique(args){const row=data[table].find(r=>matches(r,args.where));if(!row)return null;const result=structuredClone(row);if(args.include?.user)result.user=structuredClone(data.user.find(r=>r.id===row.userId));if(args.include?.session)result.session=structuredClone(data.authSession.find(r=>r.id===row.sessionId)||null);return result;},
   async findUniqueOrThrow(args){const row=await this.findUnique(args);if(!row)throw Error('Record missing');return row;},
   async update({where,data:input}){const row=data[table].find(r=>matches(r,where));if(!row)throw Error('Record missing');Object.assign(row,input);return structuredClone(row);},
   async updateMany({where,data:input}){const rows=data[table].filter(r=>matches(r,where));for(const row of rows)Object.assign(row,input);return {count:rows.length};},
   async count({where}){return data[table].filter(r=>matches(r,where)).length;},
   async deleteMany({where}){const deleted=data[table].filter(r=>matches(r,where));data[table]=data[table].filter(r=>!matches(r,where));if(table==='user'){const ids=deleted.map(r=>r.id);for(const t of ['authSession','refreshToken'])data[t]=data[t].filter(r=>!ids.includes(r.userId));}return{count:deleted.length};}
  };
  out.$queryRaw=async(_strings,id)=>data.user.filter(u=>u.id===id).map(u=>({id:u.id}));return out;
 }
 // Delegates resolve current committed state for every call.
 for(const table of Object.keys(tables))for(const method of Object.keys(client(tables)[table]))prisma[table][method]=async args=>client(tables)[table][method](args);
 prisma.$transaction=fn=>{const run=queue.then(async()=>{const draft=structuredClone(tables);const result=await fn(client(draft));tables=draft;return result;});queue=run.catch(()=>{});return run;};
 prisma.$disconnect=async()=>{};
};
