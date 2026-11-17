const assert=require('assert');const fs=require('fs');const path=require('path');
const {PDFDocument,StandardFonts,rgb}=require('pdf-lib');
module.exports=async({browser,base,dir,shots})=>{
 const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/tools/ai-table/');await page.locator('.advanced-options summary').click();await page.locator('#pdfOcr').selectOption('off');
 const drop=async(files,target='#pdfDropZone')=>{
  const transfer=await page.evaluateHandle(files=>{const dt=new DataTransfer();files.forEach(f=>dt.items.add(new File([new Uint8Array(f.bytes)],f.name,{type:f.type})));return dt;},files);
  await page.dispatchEvent(target,'dragenter',{dataTransfer:transfer});
  await page.dispatchEvent(target,'dragover',{dataTransfer:transfer});
  await page.dispatchEvent(target,'drop',{dataTransfer:transfer});await transfer.dispose();
 };
 const read=async(file,viaDrop=false)=>{if(viaDrop)await drop([{name:path.basename(file),type:'application/pdf',bytes:Array.from(fs.readFileSync(file))}]);else await page.locator('#pdfFile').setInputFiles(file);await page.locator('#importPdf').click();await page.waitForFunction(()=>!document.querySelector('#importPdf').hasAttribute('aria-busy'));assert.match(await page.locator('#importStatus').textContent(),/추출 완료/);return page.evaluate(()=>parse(document.querySelector('#source').value,'csv'));};
 // Real right-aligned values, shifted headers, reversed content stream, sparse page.
 const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica),p=doc.addPage([595,842]);
 const put=(page,text,x,y)=>page.drawText(text,{x,y,font,size:12});
 const right=(page,text,end,y)=>put(page,text,end-font.widthOfTextAtSize(text,12),y);
 right(p,'1234.56',460,710);right(p,'Store',300,710);right(p,'00123',170,710);
 put(p,'Amount',320,740);put(p,'Name',180,740);put(p,'Code',40,740);
 const p2=doc.addPage([595,842]);right(p2,'-12',460,740);right(p2,'00999',170,740);
 const file=path.join(dir,'shifted-columns.pdf');fs.writeFileSync(file,await doc.save());
 assert.deepEqual(await read(file,true),[['Code','Name','Amount'],['00123','Store','1234.56'],['00999','','-12']]);
 // Rejected/outside/busy drops must not replace the selected PDF or leave hover styling.
 const selected=()=>page.locator('#pdfFile').evaluate(el=>el.files[0].name);
 await drop([{name:'wrong.txt',type:'text/plain',bytes:[65]}]);assert.match(await page.locator('#importStatus').textContent(),/PDF 파일만/);assert.equal(await selected(),'shifted-columns.pdf');
 await drop([{name:'one.pdf',type:'application/pdf',bytes:[65]},{name:'two.pdf',type:'application/pdf',bytes:[65]}]);assert.match(await page.locator('#importStatus').textContent(),/한 개씩/);assert.equal(await selected(),'shifted-columns.pdf');
 await page.locator('#pdfFile').evaluate(el=>el.disabled=true);await drop([{name:'busy.pdf',type:'application/pdf',bytes:[65]}]);assert.equal(await selected(),'shifted-columns.pdf');await page.locator('#pdfFile').evaluate(el=>el.disabled=false);
 await drop([{name:'outside.pdf',type:'application/pdf',bytes:[65]}],'body');assert.equal(await selected(),'shifted-columns.pdf');assert.equal(await page.locator('#pdfDropZone').evaluate(el=>el.classList.contains('is-dragover')),false);
 // Bordered table: multiline cells must stay in one row; blank cells must stay blank.
 const ruled=await PDFDocument.create(),rf=await ruled.embedFont(StandardFonts.Helvetica),rp=ruled.addPage([595,842]);
 const xs=[40,160,350,530],ys=[760,730,680,640];
 for(const x of xs)rp.drawLine({start:{x,y:640},end:{x,y:760},thickness:.5,color:rgb(0,0,0)});
 for(const y of ys)rp.drawLine({start:{x:40,y},end:{x:530,y},thickness:.5,color:rgb(0,0,0)});
 const draw=(text,x,y)=>rp.drawText(text,{x,y,font:rf,size:12});
 draw('Amounts',380,742);draw('Description',190,742);draw('Code',60,742);
 draw('00123',60,710);draw('Store A',175,710);draw('second line',175,694);draw('1234.56',450,710);
 draw('00999',60,660);draw('-12',490,660);
 const ruledFile=path.join(dir,'ruled-columns.pdf');fs.writeFileSync(ruledFile,await ruled.save());
 assert.deepEqual(await read(ruledFile),[['Code','Description','Amounts'],['00123','Store A\nsecond line','1234.56'],['00999','','-12']]);
 const pending=page.waitForEvent('download');await page.locator('#excel').click();const excel=path.join(dir,'columns.xlsx');await(await pending).saveAs(excel);
 const X=require('../tools/ai-table/vendor/xlsx.min.js');const sheet=X.read(fs.readFileSync(excel),{type:'buffer'}).Sheets['표'];assert.equal(sheet.A2.v,'00123');assert.equal(sheet.B2.v,'Store A\nsecond line');assert.equal(sheet.C2.v,1234.56);assert.equal(sheet.B3.v,'');assert.equal(sheet.C3.v,-12);
 await page.screenshot({path:path.join(shots,'converter-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(shots,'converter-mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);await page.close();
};
