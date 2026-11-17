// Geometry-based PDF table reconstruction. Coordinates are in displayed-page space.
(function (root) {
  function lines(items) {
    const out = [];
    for (const it of [...items].sort((a,b)=>a.y-b.y || a.x-b.x)) {
      const last = out[out.length-1];
      if (last && Math.abs(last.y-it.y) <= Math.min(last.height,it.height)*.4) last.items.push(it);
      else out.push({y:it.y,height:it.height,items:[it]});
    }
    return out.map(line => {
      const cells=[];
      for(const it of line.items.sort((a,b)=>a.x-b.x)) {
        const prev=cells[cells.length-1], gap=prev ? it.x-prev.end : Infinity;
        // Ordinary inter-word spacing joins phrases; narrow table gutters remain separate.
        if(prev && gap < Math.max(2,it.height*.48)) {
          prev.text+=(gap>it.height*.12?' ':'')+it.text;prev.end=Math.max(prev.end,it.end);
        } else cells.push({...it});
      }
      return {...line,cells};
    });
  }
  function cutsFor(allLines) {
    if(!allLines.length)return [];
    const count=allLines.reduce((n,l)=>Math.max(n,l.cells.length),0);
    if(count>100)throw Error('추정된 열이 100개를 넘습니다. 텍스트 줄 단위로 다시 추출해주세요.');
    const full=allLines.filter(l=>l.cells.length===count);
    const cuts=[];
    for(let c=1;c<count;c++) {
      const left=full.map(l=>l.cells[c-1].end).sort((a,b)=>a-b);
      const right=full.map(l=>l.cells[c].x).sort((a,b)=>a-b);
      // The intersection of gaps keeps centered headers, left-aligned labels and
      // right-aligned amounts in the same columns. Use medians if rows overlap.
      const lower=left[left.length-1],upper=right[0];
      const x=lower<upper?(lower+upper)/2:(left[Math.floor(left.length/2)]+right[Math.floor(right.length/2)])/2;
      cuts.push(x);
    }
    return cuts.sort((a,b)=>a-b);
  }
  function textRows(allLines,cuts) {
    return allLines.map(line => {
      if(line.cells.length===cuts.length+1)return {y:line.y,row:line.cells.map(cell=>cell.text)};
      const row=Array(cuts.length+1).fill('');
      for(const cell of line.cells) {
        // Boundaries preserve left-to-right order; do not match each value independently
        // to the nearest header edge (which could swap or merge adjacent columns).
        const index=cuts.filter(x=>cell.x>=x).length;
        row[index]+=(row[index]?' ':'')+cell.text;
      }
      return {y:line.y,row};
    });
  }
  function mergeRules(rules,axis) {
    const selected=rules.filter(r=>r.axis===axis).sort((a,b)=>a.at-b.at || a.from-b.from), groups=[];
    for(const r of selected) {
      let group=groups.find(g=>Math.abs(g.at-r.at)<1);
      if(!group){group={at:r.at,segments:[]};groups.push(group);}group.segments.push([r.from,r.to]);
    }
    return groups.flatMap(g=>{
      const merged=[];
      for(const span of g.segments.sort((a,b)=>a[0]-b[0])) {
        const last=merged[merged.length-1];
        if(last && span[0]<=last[1]+2) last[1]=Math.max(last[1],span[1]);else merged.push([...span]);
      }
      return merged.map(([from,to])=>({at:g.at,from,to}));
    });
  }
  function grids(rules) {
    const h=mergeRules(rules,'h'),v=mergeRules(rules,'v'), spans=[];
    for(const line of h) {
      let span=spans.find(s=>Math.abs(s.left-line.from)<2&&Math.abs(s.right-line.to)<2);
      if(!span){span={left:line.from,right:line.to,ys:[]};spans.push(span);}span.ys.push(line.at);
    }
    const result=[];
    for(const span of spans) {
      const ys=[...new Set(span.ys)].sort((a,b)=>a-b);let run=[];
      const flush=()=>{
        if(run.length<2){run=[];return;}
        const top=run[0],bottom=run[run.length-1];
        const xs=v.filter(line=>line.at>=span.left-1&&line.at<=span.right+1 && Math.min(line.to,bottom)-Math.max(line.from,top)>(bottom-top)*.55).map(line=>line.at).sort((a,b)=>a-b);
        if(xs.length>=3 && Math.abs(xs[0]-span.left)<2 && Math.abs(xs[xs.length-1]-span.right)<2) result.push({xs,ys:[...run],top,bottom,left:span.left,right:span.right});
        run=[];
      };
      for(const y of ys) {
        if(run.length) {
          const prev=run[run.length-1];
          const sides=[span.left,span.right].every(x=>v.some(line=>Math.abs(line.at-x)<2&&line.from<=prev+2&&line.to>=y-2));
          if(!sides)flush();
        }
        run.push(y);
      }
      flush();
    }
    return result.filter((g,i)=>!result.some((other,j)=>i!==j&&other.left<=g.left&&other.right>=g.right&&other.top<=g.top&&other.bottom>=g.bottom&&(other.right-other.left>g.right-g.left)));
  }
  function inGrid(item,g) {const cy=item.y-item.height*.3;return item.x>=g.left-1&&item.x<g.right && cy>=g.top&&cy<g.bottom;}
  function gridRows(items,g) {
    const cells=Array.from({length:g.ys.length-1},()=>Array.from({length:g.xs.length-1},()=>[]));
    for(const it of items.filter(it=>inGrid(it,g))) {
      const cy=it.y-it.height*.3;
      const r=g.ys.findIndex((y,i)=>i<g.ys.length-1&&cy>=y&&cy<g.ys[i+1]);
      const c=Math.max(0,g.xs.findIndex((x,i)=>i<g.xs.length-1&&it.x>=x-1&&it.x<g.xs[i+1]-1));
      if(r>=0)cells[r][c].push(it);
    }
    return cells.map((row,r)=>({y:g.ys[r],row:row.map(cell=>lines(cell).map(l=>l.cells.map(c=>c.text).join(' ')).join('\n'))}));
  }
  function extract(pages,mode) {
    if(mode==='lines')return pages.flatMap(p=>lines(p.items).map(l=>[l.cells.map(c=>c.text).join(' ')]));
    const prepared=pages.map(p=>{
      const tables=grids(p.rules||[]);
      const outside=lines(p.items.filter(it=>!tables.some(g=>inGrid(it,g))));
      return {...p,tables,outside};
    });
    // Share column guides between unruled pages of the same size. Sparse later pages
    // must not shift their values left simply because an entire column is blank.
    const guides=new Map();
    for(const p of prepared) {
      const key=Math.round(p.width);if(!guides.has(key))guides.set(key,[]);guides.get(key).push(...p.outside);
    }
    for(const [key,value] of guides)guides.set(key,cutsFor(value));
    return prepared.flatMap(p=>[
      ...textRows(p.outside,guides.get(Math.round(p.width))),
      ...p.tables.flatMap(g=>gridRows(p.items,g))
    ].sort((a,b)=>a.y-b.y).map(r=>r.row));
  }
  async function readRules(page,viewport,lib) {
    const list=await page.getOperatorList(), O=lib.OPS, rules=[];
    let matrix=[1,0,0,1,0,0], stack=[],pending=[];
    const point=(x,y)=>lib.Util.applyTransform(lib.Util.applyTransform([x,y],matrix),viewport.transform);
    const segment=(a,b)=>{
      if(Math.abs(a[0]-b[0])<.8&&Math.abs(a[1]-b[1])>8)pending.push({axis:'v',at:(a[0]+b[0])/2,from:Math.min(a[1],b[1]),to:Math.max(a[1],b[1])});
      if(Math.abs(a[1]-b[1])<.8&&Math.abs(a[0]-b[0])>8)pending.push({axis:'h',at:(a[1]+b[1])/2,from:Math.min(a[0],b[0]),to:Math.max(a[0],b[0])});
    };
    const stroke=new Set([O.stroke,O.closeStroke,O.fillStroke,O.eoFillStroke,O.closeFillStroke,O.closeEOFillStroke]);
    const finish=new Set([O.fill,O.eoFill,O.endPath]);
    for(let n=0;n<list.fnArray.length;n++) {
      const op=list.fnArray[n],a=list.argsArray[n];
      if(op===O.save)stack.push([...matrix]);
      else if(op===O.restore)matrix=stack.pop()||[1,0,0,1,0,0];
      else if(op===O.transform)matrix=lib.Util.transform(matrix,a);
      else if(op===O.constructPath) {
        let i=0,current=null,start=null;
        for(const command of a[0]) {
          if(command===O.rectangle) {const [x,y,w,h]=a[1].slice(i,i+4);i+=4;const corners=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]].map(p=>point(...p));corners.forEach((p,k)=>segment(p,corners[(k+1)%4]));}
          else if(command===O.moveTo){current=point(a[1][i++],a[1][i++]);start=current;}
          else if(command===O.lineTo){const next=point(a[1][i++],a[1][i++]);if(current)segment(current,next);current=next;}
          else if(command===O.closePath){if(current&&start)segment(current,start);current=start;}
          else if(command===O.curveTo){i+=6;current=point(a[1][i-2],a[1][i-1]);}
          else if(command===O.curveTo2||command===O.curveTo3){i+=4;current=point(a[1][i-2],a[1][i-1]);}
        }
      } else if(stroke.has(op)){rules.push(...pending);pending=[];}
      else if(finish.has(op))pending=[];
    }
    return rules;
  }
  root.PDFTableLayout={extract,readRules};
  if(typeof module!=='undefined')module.exports=root.PDFTableLayout;
})(typeof window!=='undefined'?window:globalThis);
