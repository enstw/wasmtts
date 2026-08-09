import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const text='清晨的阳光穿过窗帘。轻轻落在安静的房间里。远处传来清脆的鸟鸣。微风带着花草的清香。让崭新的一天显得格外明亮。';
const executablePath=`${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const piperSentences=JSON.parse(execFileSync('uvx',['--from','piper-tts','python','platform/piper-inputs.py','platform/models/vits-piper-zh_CN-huayan-medium/zh_CN-huayan-medium.onnx.json',text],{encoding:'utf8',env:{...process.env,UV_CACHE_DIR:'/tmp/wasmtts-uv-cache',UV_TOOL_DIR:'/tmp/wasmtts-uv-tools'}}));
const names=process.argv[2]?[process.argv[2]]:['piper_huayan_medium','vits_aishell3','vits_melotts_zh_en'];
const browser=await chromium.launch({executablePath,headless:true});
const results=[];
for(const name of names){
  const page=await browser.newPage(); page.on('pageerror',e=>console.error(e));
  await page.goto('http://127.0.0.1:8765/platform/vits-browser.html'); await page.waitForFunction(()=>window.ready===true);
  await page.evaluate(([name,piper])=>window.bench.init(name,piper),[name,piperSentences]);
  const cdp=await page.context().newCDPSession(page); await cdp.send('Performance.enable'); const runs=[];
  const metric=(x,n)=>x.metrics.find(v=>v.name===n)?.value??0;
  for(let i=0;i<3;i++){const b=await cdp.send('Performance.getMetrics'),start=performance.now();const audio=await page.evaluate(()=>window.bench.run());const wallMs=performance.now()-start,a=await cdp.send('Performance.getMetrics');const taskMs=(metric(a,'TaskDuration')-metric(b,'TaskDuration'))*1000;runs.push({...audio,wallMs,taskMs,taskMsPer10s:taskMs*10/audio.audioSeconds});console.log(name,runs.at(-1));}
  const sorted=runs.map(x=>x.taskMsPer10s).sort((a,b)=>a-b);results.push({name,runs,medianTaskMsPer10s:sorted[1]});await page.close();
}
const baseline=results.find(x=>x.name==='piper_huayan_medium')?.medianTaskMsPer10s;for(const r of results)if(baseline)r.relativeToPiper=r.medianTaskMsPer10s/baseline;
const report={environment:{browser:browser.version(),runtime:'ONNX Runtime Web 1.27.0',executionProvider:'wasm',numThreads:1,measurement:'Chromium CDP Performance.TaskDuration'},text,results};
fs.writeFileSync(new URL('./results/results-vits-browser-wasm.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();
