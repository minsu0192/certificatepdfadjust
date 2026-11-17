const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {PDFDocument, StandardFonts} = require('pdf-lib');
module.exports = async ({browser,base,dir}) => {
 const page = await browser.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/tools/ai-table/');await page.locator('.advanced-options summary').click();
 const download = async (id,name) => {const pending=page.waitForEvent('download',{timeout:90000});await page.locator(id).click();const file=path.join(dir,name);await(await pending).saveAs(file);return file;};
 await page.locator('#sample').click();
 const exported=await download('#pdf','korean-table.pdf');
 const saved=await PDFDocument.load(fs.readFileSync(exported));assert.equal(saved.getPageCount(),1);assert(saved.getPage(0).getWidth()>saved.getPage(0).getHeight());
 // Round trip a real generated Korean PDF through text extraction.
 await page.locator('#pdfOcr').selectOption('off');await page.locator('#pdfFile').setInputFiles(exported);await page.locator('#importPdf').click();
 await page.waitForFunction(()=>document.querySelector('#importStatus').textContent.includes('추출 완료'));
 assert((await page.locator('#source').inputValue()).includes('고객코드'));assert((await page.locator('#source').inputValue()).includes('C00004'));
 const roundtrip=await page.evaluate(()=>parse(document.querySelector('#source').value,'csv'));const customer=roundtrip.find(row=>row[0]==='C00004');assert(customer,'customer stays in first column');assert.equal(customer.length,7);assert.equal(customer[2],'415,255,000');assert.equal(customer[6],'TRUE');
 assert(await page.locator('#excel').isEnabled());assert(await page.locator('#word').isEnabled());
 // Independent two-page source with a missing middle cell and right aligned numbers.
 const doc=await PDFDocument.create();const font=await doc.embedFont(StandardFonts.Helvetica);
 for(let n=0;n<2;n++) {const p=doc.addPage([595,842]);for(const [y,values] of [[740,['Code','Name','Amount']],[710,['00123','Store A','1234.56']],[680,['00999','','-12']]]) values.forEach((v,c)=>{if(v)p.drawText(v,{x:[40,200,400][c],y,size:12,font});});}
 const input=path.join(dir,'table-input.pdf');fs.writeFileSync(input,await doc.save());await page.locator('#pdfFile').setInputFiles(input);await page.locator('#importPdf').click();await page.waitForFunction(()=>!document.querySelector('#importPdf').hasAttribute('aria-busy'));
 assert((await page.locator('#source').inputValue()).includes('"00999","","-12"'));assert.equal(await page.locator('#summary').textContent(),'6행 · 3열');
 const excel=await download('#excel','from-pdf.xlsx');const X=require('../tools/ai-table/vendor/xlsx.min.js');const sheet=X.read(fs.readFileSync(excel),{type:'buffer'}).Sheets['표'];assert.equal(sheet.A2.v,'00123');assert.equal(sheet.C2.v,1234.56);assert.equal(sheet.B3.v,'');
 const word=await download('#word','from-pdf.docx');assert(fs.statSync(word).size>1000);
 // Line extraction is selectable and no header is silently removed.
 await page.locator('#pdfMode').selectOption('lines');await page.locator('#importPdf').click();await page.waitForFunction(()=>!document.querySelector('#importPdf').hasAttribute('aria-busy'));assert.equal(await page.locator('#summary').textContent(),'6행 · 1열');assert(!(await page.locator('#header').isChecked()));
 // Invalid files preserve the previous usable data and surface an error.
 const before=await page.locator('#source').inputValue();await page.locator('#pdfFile').setInputFiles({name:'bad.pdf',mimeType:'application/pdf',buffer:Buffer.from('bad')});await page.locator('#importPdf').click();await page.waitForFunction(()=>!document.querySelector('#importPdf').hasAttribute('aria-busy'));assert(await page.locator('#importStatus').evaluate(e=>e.classList.contains('error')));assert.equal(await page.locator('#source').inputValue(),before);
 // A very long cell and a wide table must paginate without losing the last cell.
 const long='가나다 '.repeat(2500)+'마지막';
 await page.locator('#source').fill('A,B,C,D,E,F,G,H,I\n'+[long,'2','3','4','5','6','7','8','끝열'].join(','));await page.locator('#format').selectOption('csv');await page.locator('#header').check();await page.locator('#preview').click();
 const multipage=await download('#pdf','long-table.pdf');assert((await PDFDocument.load(fs.readFileSync(multipage))).getPageCount()>2);
 const text=await page.evaluate(async bytes=>{const d=await pdfjsLib.getDocument({data:new Uint8Array(bytes)}).promise;let text='';for(let i=1;i<=d.numPages;i++)text+=(await(await d.getPage(i)).getTextContent()).items.map(t=>t.str).join('');await d.destroy();return text;},Array.from(fs.readFileSync(multipage)));assert(text.includes('마지막'));assert(text.includes('끝열'));
 // Real image-only PDF exercises the OCR import path.
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1200;c.height=600;const ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1200,600);ctx.fillStyle='black';ctx.font='48px Arial';ctx.fillText('INVOICE TOTAL 1234.56',80,180);return c.toDataURL('image/png').split(',')[1];});
 const scan=await PDFDocument.create();const img=await scan.embedPng(Buffer.from(png,'base64'));scan.addPage([600,300]).drawImage(img,{x:0,y:0,width:600,height:300});const scanFile=path.join(dir,'table-scan.pdf');fs.writeFileSync(scanFile,await scan.save());
 await page.locator('#pdfFile').setInputFiles(scanFile);await page.locator('#pdfOcr').selectOption('eng');await page.locator('#importPdf').click();await page.waitForFunction(()=>!document.querySelector('#importPdf').hasAttribute('aria-busy'),null,{timeout:120000});assert.match(await page.locator('#source').inputValue(),/INVOICE TOTAL 1234.56/);assert.match(await page.locator('#importStatus').textContent(),/1페이지 OCR/);
 assert.deepEqual(errors,[]);await page.close();
};
