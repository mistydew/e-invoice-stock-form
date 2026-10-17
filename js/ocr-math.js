// CTC positions are model time steps, not evenly divided character widths.
export function decodeCtc(data, steps, classes, dictionary) {
  const tokens=[];
  let previous=0;
  for(let t=0;t<steps;t++) {
    let best=0,score=data[t*classes];
    for(let c=1;c<classes;c++)if(data[t*classes+c]>score){best=c;score=data[t*classes+c];}
    if(best && best!==previous)tokens.push({text:dictionary[best] || '',score,start:t,end:t});
    else if(best && tokens.length)tokens[tokens.length-1].end=t;
    previous=best;
  }
  return {text:tokens.map(t=>t.text).join(''),confidence:tokens.length ? tokens.reduce((s,t)=>s+t.score,0)/tokens.length*100 : 0,tokens};
}

export function detectionSize(width,height,limit=1280) {
  const ratio=Math.min(1,limit/Math.max(width,height));
  return {width:Math.max(32,Math.round(width*ratio/32)*32),height:Math.max(32,Math.round(height*ratio/32)*32)};
}
