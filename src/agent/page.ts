// A small first-party interface. Dynamic source text is always inserted with
// textContent, never interpreted as HTML or model-authored Markdown.
export const AGENT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Explore Trinity sermons</title><style>
body{font-family:system-ui,sans-serif;background:#f6f4ef;color:#222b27;max-width:760px;margin:64px auto;padding:0 24px;line-height:1.65}
h1{font-size:40px;line-height:1.15}textarea{box-sizing:border-box;width:100%;font:inherit;border:1px solid #a8b0a9;border-radius:10px;padding:16px;background:white}button{font:inherit;background:#214c3c;color:white;border:0;border-radius:8px;padding:12px 24px;margin-top:12px;cursor:pointer}button:disabled{opacity:.6}article{background:white;border:1px solid #ddd;border-radius:12px;padding:24px;margin-top:20px}h2{font-size:21px;margin:0}a{color:#214c3c}small{color:#59665f}blockquote{border-left:3px solid #b6c8bd;margin:20px 0;padding-left:18px;white-space:pre-wrap}#status{margin-top:24px}label{display:block;font-weight:600;margin-bottom:8px}
</style></head><body><small>TRINITY NEW YORK · SERMON DISCOVERY</small><h1>Find a message to explore.</h1>
<p>Search a topic or check a quotation. Read excerpts from sermon transcripts, with links to the full messages.</p>
<p><small>This tool helps you explore sermons. It doesn't offer personal spiritual direction. Transcript captions may contain errors.</small></p>
<form id="search"><label for="question">What would you like to explore?</label><textarea id="question" rows="3" minlength="3" maxlength="2000" required placeholder="Find sermons about dealing with grief"></textarea><button id="submit">Find sermons</button></form>
<div id="status" role="status" aria-live="polite"></div><section id="results" aria-label="Sermon results"></section>
<script>
const form=document.getElementById('search'),status=document.getElementById('status'),results=document.getElementById('results'),button=document.getElementById('submit');
function node(tag,text){const n=document.createElement(tag);n.textContent=text;return n;}
form.addEventListener('submit',async e=>{e.preventDefault();button.disabled=true;results.replaceChildren();status.textContent='Searching sermons and checking source excerpts…';
try{const r=await fetch('/api/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:document.getElementById('question').value})});const data=await r.json();if(!r.ok)throw new Error(data.error||data.message||'Search unavailable. Please try again.');status.textContent=data.message;
if(data.quoteStatus)status.append(node('p',data.quoteStatus==='verified_in_transcript'?'Quotation found in the checked transcript.':'Quotation not verified in the sources checked.'));
for(const card of data.cards){const article=node('article',''),h=node('h2',''),link=node('a',card.title);const url=new URL(card.youtubeUrl);if(url.origin!=='https://www.youtube.com'||url.pathname!=='/watch')continue;link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';h.append(link);article.append(h,node('small',(card.preacher||'Preacher not recorded')+' · Published '+card.publishedAt));article.append(node('p',card.fit==='direct'?'Excerpt addressing your topic':'Related excerpt — a partial match'));article.append(node('blockquote','…'+card.evidence.text+'…'));article.append(node('small','Transcript excerpt · '+(card.evidence.source==='youtube_auto'?'Automatic captions':'Source captions')+' · Read in the context of the full sermon.'));results.append(article);}
}catch(err){status.textContent=err.message||'Search unavailable. Please try again.';}finally{button.disabled=false;}});
</script></body></html>`;
