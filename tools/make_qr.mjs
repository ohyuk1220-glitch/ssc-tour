// 사용법: node tools/make_qr.mjs
// qrcode와 sharp-cli는 npx로 일회성 실행하며 package.json을 변경하지 않습니다.
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const toolsDir=dirname(fileURLToPath(import.meta.url));
const rootDir=resolve(toolsDir,"..");
const outDir=join(toolsDir,"qr_out");
const tempDir=join(toolsDir,".qr_tmp-"+process.pid);
const baseUrl="https://ohyuk1220-glitch.github.io/ssc-tour/h.html?scan=";
const secretsPath=join(toolsDir,"qr_secrets.json");

function run(args){
  const result=spawnSync("npx",["--yes",...args],{cwd:rootDir,encoding:"utf8",maxBuffer:10*1024*1024});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error("npx "+args[0]+" 실패\n"+(result.stderr||result.stdout||""));
}
function xml(text){
  return text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function addCaption(svg,name,qid){
  const match=svg.match(/viewBox=["']0 0 ([\d.]+) ([\d.]+)["']/);
  if(!match)throw new Error(qid+" QR SVG의 viewBox를 읽을 수 없습니다.");
  const size=Number(match[1]), caption=9, height=Math.round(640*(size+caption)/size);
  const root='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="'+height+'" viewBox="0 0 '+size+' '+(size+caption)+'" shape-rendering="crispEdges">';
  const label='<rect x="0" y="'+size+'" width="'+size+'" height="'+caption+'" fill="#fff"/>'+
    '<text x="'+(size/2)+'" y="'+(size+3.3)+'" text-anchor="middle" font-family="Apple SD Gothic Neo,Noto Sans CJK KR,Arial Unicode MS,sans-serif" font-size="2.25" font-weight="700" fill="#1f1f1f">'+xml(name)+'</text>'+
    '<text x="'+(size/2)+'" y="'+(size+6.4)+'" text-anchor="middle" font-family="Arial,sans-serif" font-size="1.35" font-weight="600" fill="#666">'+xml(qid)+'</text>';
  return svg.replace(/<svg\b[^>]*>/,root).replace("</svg>",label+"</svg>");
}

const html=readFileSync(join(rootDir,"h.html"),"utf8");
const exhibits=[...html.matchAll(/\{name:"([^"]+)", kind:"exhibit", qid:"([a-z-]+)"/g)]
  .map(m=>({name:m[1],qid:m[2]}));
const unique=new Set(exhibits.map(e=>e.qid));
if(exhibits.length!==24||unique.size!==24)throw new Error("h.html에서 고유한 전시물 QR 24개를 찾지 못했습니다.");
if(!existsSync(secretsPath)){
  throw new Error("tools/qr_secrets.json이 없습니다. 먼저 node tools/gen_qr_tokens.mjs를 실행해 토큰을 발급하세요.");
}
let secrets;
try{secrets=JSON.parse(readFileSync(secretsPath,"utf8"));}
catch(e){throw new Error("tools/qr_secrets.json을 읽을 수 없습니다: "+e.message);}
for(const exhibit of exhibits){
  const token=secrets&&secrets[exhibit.qid];
  if(typeof token!=="string"||!/^[A-Z2-7]{10}$/.test(token)){
    throw new Error(exhibit.qid+"의 유효한 base32 10자 토큰이 qr_secrets.json에 없습니다.");
  }
}

rmSync(outDir,{recursive:true,force:true});
rmSync(tempDir,{recursive:true,force:true});
mkdirSync(outDir,{recursive:true});
mkdirSync(tempDir,{recursive:true});

try{
  const svgs=[];
  for(const exhibit of exhibits){
    const path=join(tempDir,exhibit.qid+".svg");
    const url=baseUrl+encodeURIComponent(exhibit.qid)+"&k="+encodeURIComponent(secrets[exhibit.qid]);
    run(["qrcode","-t","svg","-e","H","-w","640","-q","4","-o",path,url]);
    writeFileSync(path,addCaption(readFileSync(path,"utf8"),exhibit.name,exhibit.qid));
    svgs.push(path);
  }
  run(["sharp-cli","-i",...svgs,"-o",outDir,"-f","png"]);
  console.log("현장 QR PNG "+exhibits.length+"장을 생성했습니다: "+outDir);
}finally{
  rmSync(tempDir,{recursive:true,force:true});
}
