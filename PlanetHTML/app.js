(function(){
  'use strict';
  const $=id=>document.getElementById(id),html=$('html'),css=$('css'),frame=$('preview');
  let files=new Map(),entryPath='',blobUrls=[],visual=false,refreshTimer=0,lastPreview='',selected=null,history=[],future=[];
  const VOID=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  const RAW=new Set(['pre','textarea','script','style']);
  const SAMPLE='<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Visual editing sample</title>\n  <style>\n    * { box-sizing: border-box; }\n    body { margin: 0; font-family: system-ui, sans-serif; background: #f4f7f5; color: #17201c; }\n    header { padding: 28px 7vw; background: #173d30; color: white; }\n    main { max-width: 900px; margin: auto; padding: 50px 24px; }\n    .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }\n    .card { padding: 22px; border-radius: 14px; background: white; box-shadow: 0 7px 22px #163b2c18; }\n    .misplaced { border: 2px dashed #d87060; }\n    @media (max-width: 650px) { .cards { grid-template-columns: 1fr; } }\n  </style>\n</head>\n<body>\n  <header><h1>Drag the misplaced card</h1><p>Turn on Visual edit, then move it into the card grid.</p></header>\n  <main>\n    <section class="cards">\n      <article class="card"><h2>Format</h2><p>Clean, readable HTML.</p></article>\n      <article class="card"><h2>Preview</h2><p>Responsive and sandboxed.</p></article>\n    </section>\n    <article class="card misplaced"><h2>Visual fix</h2><p>I belong inside the grid above.</p></article>\n  </main>\n</body>\n</html>';

  function setStatus(text,kind){$('status').textContent=text;$('status').className='status'+(kind?' '+kind:'');}
  function size(n){return n<1024?n+' B':(n/1024).toFixed(1)+' KB';}
  function updateStats(){const n=new Blob([html.value]).size;$('code-stats').textContent=html.value?html.value.split('\n').length+' lines · '+size(n):'';}
  function normalize(path){const out=[];path.replace(/\\/g,'/').split('/').forEach(x=>{if(!x||x==='.')return;if(x==='..')out.pop();else out.push(x);});return out.join('/');}
  function dirname(path){const a=path.split('/');a.pop();return a.join('/');}
  function localPath(base,ref){if(!ref||/^(?:[a-z]+:|\/\/|#|data:|blob:)/i.test(ref))return null;const clean=ref.split(/[?#]/)[0];return clean[0]==='/'?normalize(clean.slice(1)):normalize((dirname(base)?dirname(base)+'/':'')+clean);}
  function revokeUrls(){blobUrls.forEach(URL.revokeObjectURL);blobUrls=[];}
  function objectUrl(file){const u=URL.createObjectURL(file);blobUrls.push(u);return u;}
  function fileText(file){return file.text();}
  function escapeScript(s){return s.replace(/<\/script/gi,'<\\/script');}

  function formatHTML(source){
    source=source.trim();if(!source)return '';
    const protectedParts=[];source=source.replace(/<(pre|textarea|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,m=>'___PHTML_RAW_'+(protectedParts.push(m)-1)+'___');
    const tokens=source.replace(/>\s*</g,'><').match(/<!DOCTYPE[^>]*>|<!--[^]*?-->|<[^>]+>|[^<]+/gi)||[];let level=0,out=[];
    tokens.forEach(t=>{if(/^___PHTML_RAW_/.test(t)){const m=protectedParts[+t.match(/\d+/)[0]],tag=(m.match(/^<(\w+)/)||[])[1]||'';out.push('  '.repeat(level)+m.trim());return;}if(/^\s*$/.test(t))return;if(/^<\//.test(t))level=Math.max(0,level-1);out.push('  '.repeat(level)+t.trim());if(/^<[^!/?][^>]*>$/.test(t)&&!/^<\w+[^>]*\/>$/.test(t)){const tag=(t.match(/^<([\w-]+)/)||[])[1];if(tag&&!VOID.has(tag.toLowerCase())&&!new RegExp('</'+tag+'\s*>$','i').test(t))level++;}});
    return out.join('\n').replace(/___PHTML_RAW_(\d+)___/g,(_,i)=>protectedParts[+i]);
  }
  function minifyHTML(source){const keep=[];source=source.replace(/<(pre|textarea|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,m=>'___PHTML_KEEP_'+(keep.push(m)-1)+'___');source=source.replace(/<!--(?!\[if)[\s\S]*?-->/g,'').replace(/>\s+</g,'><').replace(/\s{2,}/g,' ').trim();return source.replace(/___PHTML_KEEP_(\d+)___/g,(_,i)=>keep[+i]);}

  function assignIds(doc){let i=0;doc.body&&doc.body.querySelectorAll('*').forEach(el=>{if(!['SCRIPT','STYLE','LINK','META','TITLE','BASE'].includes(el.tagName))el.setAttribute('data-phtml-id','n'+i++);});}
  function cleanIds(doc){doc.querySelectorAll('[data-phtml-id]').forEach(el=>el.removeAttribute('data-phtml-id'));}
  function serializeDoc(doc){cleanIds(doc);let out='<!DOCTYPE html>\n'+doc.documentElement.outerHTML;return formatHTML(out);}
  function sourceDoc(){const doc=new DOMParser().parseFromString(html.value||'<html><head></head><body></body></html>','text/html');assignIds(doc);return doc;}
  function historyState(){return JSON.stringify({html:html.value,css:css.value});}
  function updateHistory(){ $('undo').disabled=!history.length;$('redo').disabled=!future.length; }
  function checkpoint(){history.push(historyState());if(history.length>60)history.shift();future=[];updateHistory();}
  function restoreState(raw){const s=JSON.parse(raw);html.value=s.html;css.value=s.css;updateStats();schedule();}

  async function rewriteCss(text,path){
    text=text.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi,(m,q,ref)=>{const p=localPath(path,ref),f=p&&files.get(p);return f?'url("'+objectUrl(f)+'")':m;});
    const imports=[...text.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/gi)];
    for(const m of imports){const p=localPath(path,m[1]),f=p&&files.get(p);if(f){const nested=await rewriteCss(await fileText(f),p);text=text.replace(m[0],nested);}}
    return text;
  }
  async function resolveProject(doc){
    const base=entryPath||'index.html';
    for(const link of [...doc.querySelectorAll('link[rel~="stylesheet"][href]')]){const p=localPath(base,link.getAttribute('href')),f=p&&files.get(p);if(f){const style=doc.createElement('style');style.setAttribute('data-project-source',p);style.textContent=await rewriteCss(await fileText(f),p);link.replaceWith(style);}}
    for(const style of [...doc.querySelectorAll('style')])style.textContent=await rewriteCss(style.textContent,base);
    for(const script of [...doc.querySelectorAll('script[src]')]){const p=localPath(base,script.getAttribute('src')),f=p&&files.get(p);if(f){script.removeAttribute('src');script.setAttribute('data-project-source',p);script.textContent=escapeScript(await fileText(f));}}
    for(const el of [...doc.querySelectorAll('[src]')]){if(el.tagName==='SCRIPT')continue;const p=localPath(base,el.getAttribute('src')),f=p&&files.get(p);if(f)el.setAttribute('src',objectUrl(f));}
    for(const el of [...doc.querySelectorAll('[poster]')]){const p=localPath(base,el.getAttribute('poster')),f=p&&files.get(p);if(f)el.setAttribute('poster',objectUrl(f));}
    for(const el of [...doc.querySelectorAll('[srcset]')]){const parts=el.getAttribute('srcset').split(',').map(part=>{const bits=part.trim().split(/\s+/),p=localPath(base,bits[0]),f=p&&files.get(p);if(f)bits[0]=objectUrl(f);return bits.join(' ');});el.setAttribute('srcset',parts.join(', '));}
  }

  function bridgeCode(){return `(function(){
var visual=false,selected=null,drag=null,marker=document.createElement('div');marker.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #5cb692;background:rgba(92,182,146,.10);display:none';document.documentElement.appendChild(marker);
function send(type,data){parent.postMessage(Object.assign({source:'PlanetHTML',type:type},data||{}),'*')}
['log','warn','error'].forEach(function(k){var old=console[k];console[k]=function(){var a=[].slice.call(arguments).map(function(x){try{return typeof x==='string'?x:JSON.stringify(x)}catch(_){return String(x)}});send('console',{level:k,message:a.join(' ')});old.apply(console,arguments)}});
addEventListener('error',function(e){send('console',{level:'error',message:e.message+' · '+(e.filename||'inline')+':'+(e.lineno||0)})});addEventListener('unhandledrejection',function(e){send('console',{level:'error',message:'Unhandled promise: '+String(e.reason)})});
function editable(t){return t&&t.closest&&t.closest('[data-phtml-id]')}
function box(el,color){if(!el){marker.style.display='none';return}var r=el.getBoundingClientRect();marker.style.display='block';marker.style.left=r.left+'px';marker.style.top=r.top+'px';marker.style.width=r.width+'px';marker.style.height=r.height+'px';marker.style.borderColor=color||'#5cb692'}
function meta(el){var r=el.getBoundingClientRect();return{id:el.dataset.phtmlId,tag:el.tagName.toLowerCase(),elementId:el.id||'',classes:el.className&&typeof el.className==='string'?el.className:'',text:el.children.length?'':el.textContent||'',box:Math.round(r.width)+' × '+Math.round(r.height)+' px · '+getComputedStyle(el).display}}
addEventListener('message',function(e){if(!e.data||e.data.source!=='PlanetHTMLParent')return;if(e.data.type==='visual'){visual=!!e.data.on;document.documentElement.style.cursor=visual?'crosshair':'';if(!visual)box(null)}});
addEventListener('click',function(e){if(!visual)return;var el=editable(e.target);if(!el)return;e.preventDefault();e.stopPropagation();selected=el;box(el);send('selected',meta(el))},true);
addEventListener('pointerdown',function(e){if(!visual)return;var el=editable(e.target);if(!el)return;e.preventDefault();e.stopPropagation();selected=el;drag={id:el.dataset.phtmlId,target:null,pos:null,x:e.clientX,y:e.clientY};el.setPointerCapture&&el.setPointerCapture(e.pointerId);box(el);send('selected',meta(el))},true);
addEventListener('pointermove',function(e){if(!drag||Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<4)return;marker.style.display='none';var target=editable(document.elementFromPoint(e.clientX,e.clientY));if(!target||target===selected||selected.contains(target)){box(selected);return}var r=target.getBoundingClientRect(),ratio=(e.clientY-r.top)/Math.max(1,r.height),pos=ratio<.28?'before':ratio>.72?'after':'inside';drag.target=target.dataset.phtmlId;drag.pos=pos;box(target,pos==='inside'?'#5cb692':'#e1be72')},true);
addEventListener('pointerup',function(e){if(!drag)return;var d=drag;drag=null;if(d.target){send('operation',{op:'move',id:d.id,target:d.target,position:d.pos})}else if(selected)box(selected)},true);
send('ready',{});
})();`}
  async function buildPreview(includeBridge){
    revokeUrls();const doc=sourceDoc();await resolveProject(doc);if(css.value.trim()){const s=doc.createElement('style');s.setAttribute('data-planethtml-extra','');s.textContent=await rewriteCss(css.value,entryPath||'index.html');doc.head.appendChild(s);}if(includeBridge){const s=doc.createElement('script');s.setAttribute('data-planethtml-bridge','');s.textContent=escapeScript(bridgeCode());doc.head.insertBefore(s,doc.head.firstChild);}return '<!DOCTYPE html>'+doc.documentElement.outerHTML;
  }
  async function refresh(){
    if(!html.value.trim()){frame.removeAttribute('srcdoc');$('preview-state').textContent='Waiting for HTML';return;}
    try{lastPreview=await buildPreview(true);frame.srcdoc=lastPreview;$('preview-state').textContent=files.size?'Project preview · '+files.size+' files':'Single-page preview';updateStats();setStatus('Preview refreshed. Visual edits will update the HTML source.','ok');try{localStorage.setItem('planethtml_autosave',JSON.stringify({html:html.value,css:css.value}));}catch(_){}}
    catch(e){setStatus('Preview error: '+e.message,'err');}
  }
  function schedule(){clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,350);updateStats();}
  function postVisual(){frame.contentWindow&&frame.contentWindow.postMessage({source:'PlanetHTMLParent',type:'visual',on:visual},'*');}

  function applyOperation(d){
    const doc=sourceDoc(),el=doc.querySelector('[data-phtml-id="'+d.id+'"]');if(!el)return;
    checkpoint();
    if(d.op==='move'){const target=doc.querySelector('[data-phtml-id="'+d.target+'"]');if(!target||target===el||el.contains(target))return;if(d.position==='before')target.before(el);else if(d.position==='after')target.after(el);else target.append(el);}
    if(d.op==='props'){el.id=d.elementId||'';el.className=d.classes||'';if(d.text!==undefined&&d.text!==null&&!el.children.length)el.textContent=d.text;}
    if(d.op==='duplicate')el.after(el.cloneNode(true));if(d.op==='delete')el.remove();
    html.value=serializeDoc(doc);selected=null;$('properties').hidden=true;$('inspector-empty').hidden=false;schedule();setStatus('Visual change applied to the HTML source.','ok');
  }
  function showSelected(d){selected=d;$('selected-label').textContent='<'+d.tag+'>';$('inspector-empty').hidden=true;$('properties').hidden=false;$('prop-tag').value=d.tag;$('prop-id').value=d.elementId;$('prop-class').value=d.classes;$('prop-text').value=d.text;$('prop-text').disabled=d.text===''&&['div','section','main','article','header','footer','nav','ul','ol'].includes(d.tag);$('box-info').textContent=d.box;}
  function addLog(level,message){const box=$('console-output'),row=document.createElement('div');row.className='log '+level;row.textContent=message;box.appendChild(row);box.scrollTop=box.scrollHeight;while(box.children.length>80)box.firstChild.remove();}
  addEventListener('message',e=>{const d=e.data;if(!d||d.source!=='PlanetHTML')return;if(d.type==='ready')postVisual();if(d.type==='selected')showSelected(d);if(d.type==='operation')applyOperation(d);if(d.type==='console')addLog(d.level,d.message);});

  async function openHtml(file){if(!file)return;files.clear();entryPath=file.name;files.set(file.name,file);html.value=await fileText(file);renderFiles();schedule();setStatus('Opened '+file.name+'.','ok');}
  async function openFolder(list){files.clear();const arr=[...list];if(!arr.length)return;arr.forEach(f=>{let p=(f.webkitRelativePath||f.name).replace(/\\/g,'/'),parts=p.split('/');if(parts.length>1)parts.shift();files.set(parts.join('/'),f);});const pages=[...files.keys()].filter(p=>/\.html?$/i.test(p));if(!pages.length){setStatus('This folder does not contain an HTML file.','err');return;}entryPath=pages.find(p=>/(^|\/)index\.html?$/i.test(p))||pages[0];html.value=await fileText(files.get(entryPath));renderFiles();schedule();setStatus('Opened project with '+files.size+' files. Entry: '+entryPath,'ok');}
  function icon(path){return /\.html?$/i.test(path)?'◇':/\.css$/i.test(path)?'#':/\.(js|mjs)$/i.test(path)?'JS':/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(path)?'▧':'·';}
  function renderFiles(){const tree=$('file-tree'),entry=$('entry');tree.innerHTML='';entry.innerHTML='';const paths=[...files.keys()].sort();paths.forEach(p=>{const f=files.get(p),row=document.createElement('div');row.className='file'+(p===entryPath?' active':'');row.innerHTML='<b></b><span></span><small></small>';row.querySelector('b').textContent=icon(p);row.querySelector('span').textContent=p;row.querySelector('small').textContent=size(f.size);tree.appendChild(row);if(/\.html?$/i.test(p)){const o=document.createElement('option');o.value=p;o.textContent=p;o.selected=p===entryPath;entry.appendChild(o);}});$('file-count').textContent=files.size?files.size+' files':'single page';if(!paths.length)tree.innerHTML='<div class="empty-list">No folder opened.</div>';}

  $('open-html').onclick=()=>$('html-file').click();$('html-file').onchange=e=>{openHtml(e.target.files[0]);e.target.value='';};$('open-folder').onclick=()=>$('folder-input').click();$('folder-input').onchange=e=>{openFolder(e.target.files);e.target.value='';};$('entry').onchange=async()=>{entryPath=$('entry').value;html.value=await fileText(files.get(entryPath));renderFiles();schedule();};
  $('sample').onclick=()=>{checkpoint();files.clear();entryPath='index.html';html.value=SAMPLE;css.value='';renderFiles();refresh();};$('format').onclick=()=>{checkpoint();html.value=formatHTML(html.value);updateStats();schedule();setStatus('HTML beautified.','ok');};$('minify').onclick=()=>{checkpoint();html.value=minifyHTML(html.value);updateStats();schedule();setStatus('HTML minified.','ok');};
  $('copy').onclick=async()=>{try{await navigator.clipboard.writeText(html.value);setStatus('HTML copied to the clipboard.','ok');}catch(_){setStatus('Clipboard access was blocked.','err');}};$('download').onclick=()=>{if(!html.value)return;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([html.value],{type:'text/html'}));a.download=(entryPath.split('/').pop()||'index.html');a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
  $('clear').onclick=()=>{files.clear();entryPath='';html.value=css.value='';frame.removeAttribute('srcdoc');renderFiles();updateStats();setStatus('Workspace cleared.');try{localStorage.removeItem('planethtml_autosave');}catch(_){}};$('refresh').onclick=refresh;
  $('undo').onclick=()=>{if(!history.length)return;future.push(historyState());restoreState(history.pop());updateHistory();};$('redo').onclick=()=>{if(!future.length)return;history.push(historyState());restoreState(future.pop());updateHistory();};
  $('visual-mode').onchange=()=>{visual=$('visual-mode').checked;postVisual();$('preview-state').textContent=visual?'Visual edit enabled · drag elements':'Preview mode';};
  document.querySelectorAll('[data-size]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-size]').forEach(x=>x.classList.toggle('active',x===b));frame.style.width=b.dataset.size==='100%'?'100%':b.dataset.size+'px';$('viewport').textContent=b.textContent+' · '+(b.dataset.size==='100%'?'responsive':b.dataset.size+' px');});
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===b));const isHtml=b.dataset.tab==='html';html.hidden=!isHtml;css.hidden=isHtml;});
  $('apply-props').onclick=()=>selected&&applyOperation({op:'props',id:selected.id,elementId:$('prop-id').value.trim(),classes:$('prop-class').value.trim(),text:$('prop-text').disabled?null:$('prop-text').value});$('duplicate').onclick=()=>selected&&applyOperation({op:'duplicate',id:selected.id});$('delete-el').onclick=()=>selected&&applyOperation({op:'delete',id:selected.id});
  $('clear-console').onclick=()=>$('console-output').innerHTML='<div class="log muted">Console cleared.</div>';$('new-tab').onclick=async()=>{const win=open('about:blank','_blank');if(!win)return setStatus('The browser blocked the preview tab. Allow pop-ups and try again.','err');const src=await buildPreview(false),u=URL.createObjectURL(new Blob([src],{type:'text/html'}));win.location.href=u;setTimeout(()=>URL.revokeObjectURL(u),60000);};
  html.addEventListener('input',schedule);css.addEventListener('input',schedule);frame.addEventListener('load',postVisual);
  addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?$('redo').click():$('undo').click();}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();$('redo').click();}});
  try{const saved=JSON.parse(localStorage.getItem('planethtml_autosave')||'null');if(saved){html.value=saved.html||'';css.value=saved.css||'';if(html.value)refresh();}}catch(_){}renderFiles();updateStats();updateHistory();
})();
