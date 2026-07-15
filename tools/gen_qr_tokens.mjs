// 사용법: node tools/gen_qr_tokens.mjs [--force]
// --force는 이미 인쇄한 QR을 모두 무효화하므로 토큰을 정말 재발급할 때만 사용합니다.
import {createHash, randomBytes} from "node:crypto";
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const toolsDir=dirname(fileURLToPath(import.meta.url));
const rootDir=resolve(toolsDir,"..");
const secretsPath=join(toolsDir,"qr_secrets.json");
const hashesPath=join(toolsDir,"qr_hashes.json");
const force=process.argv.slice(2).includes("--force");
const unknownArgs=process.argv.slice(2).filter(arg=>arg!=="--force");
const base32="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

if(unknownArgs.length)throw new Error("알 수 없는 옵션: "+unknownArgs.join(" "));

function readExhibitQids(){
  const html=readFileSync(join(rootDir,"h.html"),"utf8");
  const qids=[...html.matchAll(/\{name:"[^"]+", kind:"exhibit", qid:"([a-z-]+)"/g)].map(m=>m[1]);
  const unique=new Set(qids);
  if(qids.length!==24||unique.size!==24)throw new Error("h.html에서 고유한 전시물 qid 24개를 찾지 못했습니다.");
  return qids;
}
function makeToken(){
  const bytes=randomBytes(10);
  let token="";
  for(const byte of bytes)token+=base32[byte&31];
  return token;
}
function validateSecrets(value,qids){
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("qr_secrets.json 형식이 올바르지 않습니다.");
  const expected=new Set(qids), keys=Object.keys(value);
  if(keys.length!==qids.length||keys.some(qid=>!expected.has(qid)))throw new Error("qr_secrets.json의 qid가 h.html 전시물 24개와 일치하지 않습니다.");
  for(const qid of qids){
    if(typeof value[qid]!=="string"||!new RegExp("^["+base32+"]{10}$").test(value[qid])){
      throw new Error(qid+" 토큰은 base32(A-Z2-7) 10자여야 합니다.");
    }
  }
  if(new Set(Object.values(value)).size!==qids.length)throw new Error("qr_secrets.json에 중복 토큰이 있습니다.");
  return value;
}

const qids=readExhibitQids();
let secrets;
if(existsSync(secretsPath)&&!force){
  secrets=validateSecrets(JSON.parse(readFileSync(secretsPath,"utf8")),qids);
  console.log("기존 qr_secrets.json을 유지합니다. 재발급하려면 --force를 명시하세요.");
}else{
  const used=new Set(); secrets={};
  for(const qid of qids){
    let token;
    do token=makeToken(); while(used.has(token));
    used.add(token); secrets[qid]=token;
  }
  writeFileSync(secretsPath,JSON.stringify(secrets,null,2)+"\n",{mode:0o600});
  console.log("QR 비밀 토큰 "+qids.length+"개를 발급했습니다: "+secretsPath);
}

const hashes={};
for(const qid of qids){
  hashes[qid]=createHash("sha256").update(qid+":"+secrets[qid]).digest("hex");
}
writeFileSync(hashesPath,JSON.stringify(hashes,null,2)+"\n");
console.log("h.html용 SHA-256 해시를 저장했습니다: "+hashesPath);
