const assert=require('assert');const fs=require('fs');const path=require('path');const cp=require('child_process');
module.exports=async({browser,base,dir,shots})=>{
 const page=await browser.newPage({viewport:{width:1280,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/tools/ai-table/');await page.locator('#sample').click();assert.equal(await page.locator('#summary').textContent(),'3행 · 7열');
 for(const ext of ['xlsx','docx']){const pending=page.waitForEvent('download');await page.locator(ext==='xlsx'?'#excel':'#word').click();const file=path.join(dir,'sample.'+ext);await(await pending).saveAs(file);const xml=cp.execFileSync('python3',['-c',`import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1]);print(z.read('${ext==='xlsx'?'xl/worksheets/sheet1.xml':'word/document.xml'}').decode())`,file],{encoding:'utf8'});assert(xml.includes('C00004'));assert(xml.includes(ext==='xlsx'?'415255000':'415,255,000'));if(ext==='docx')assert(xml.includes('landscape'));}
 await page.screenshot({path:path.join(shots,'ai-table-desktop.png'),fullPage:true});
 await page.locator('#source').fill('코드,설명,금액,빈칸,긴번호,수식\n00123,"쉼표, 포함\n두 줄",1234,,1234567890123456,=1+1');await page.locator('#preview').click();assert.equal(await page.locator('#summary').textContent(),'1행 · 6열');
 const result=await page.evaluate(()=>{const ws=XLSX.utils.aoa_to_sheet(converted());return {a:ws.A2,c:ws.C2,d:ws.D2,e:ws.E2,f:ws.F2};});assert.equal(result.a.v,'00123');assert.equal(result.c.t,'n');assert.equal(result.d.v,'');assert.equal(result.e.t,'s');assert.equal(result.f.t,'s');assert(!result.f.f);
 // Read the downloaded workbook to verify integer and decimal display formats.
 await page.locator('#source').fill('항목,금액\n정수,1234\n소수,1234.56\n영,0\n음수,-1234');await page.locator('#preview').click();
 const excelDownload=page.waitForEvent('download');await page.locator('#excel').click();const excelPath=path.join(dir,'number-formats.xlsx');await(await excelDownload).saveAs(excelPath);
 const XLSX=require('../tools/ai-table/vendor/xlsx.min.js');const sheet=XLSX.read(fs.readFileSync(excelPath),{type:'buffer',cellNF:true}).Sheets['표'];
 assert.equal(sheet.B2.z,'#,##0');assert.equal(sheet.B2.w,'1,234');assert.equal(sheet.B3.w,'1,234.56');assert.equal(sheet.B4.w,'0');assert.equal(sheet.B5.w,'-1,234');assert.equal(sheet.B2.t,'n');
 await page.locator('#source').fill('```markdown\n| 코드 | 금액 |\n| --- | ---: |\n| A\\|B | 1,234 |\n```');await page.locator('#preview').click();assert.equal(await page.locator('td').first().textContent(),'A|B');assert.equal(await page.locator('td').nth(1).textContent(),'1,234');
 await page.locator('#source').fill('a\tb\tc\n001\t2\t');await page.locator('#preview').click();assert.equal(await page.locator('#summary').textContent(),'1행 · 3열');
 await page.locator('#source').fill('a,b\n1,2,3');await page.locator('#preview').click();assert(await page.locator('#excel').isDisabled());assert((await page.locator('#status').textContent()).includes('2행'));
 await page.locator('#source').fill('a,b\n"unfinished,2');await page.locator('#preview').click();assert((await page.locator('#status').textContent()).includes('따옴표'));
 await page.locator('#sample').click();await page.locator('#source').fill('changed');assert(await page.locator('#word').isDisabled());
 await page.setViewportSize({width:390,height:844});await page.locator('#sample').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(shots,'ai-table-mobile.png'),fullPage:true});assert.deepEqual(errors,[]);await page.close();
};
