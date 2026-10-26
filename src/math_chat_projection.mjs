// Split only the presentation rows of a single outer aligned environment.
// Braced expressions, nested environments and \left...\right pairs remain intact.
export function mathChatRows(content) {
  const match=/^\\begin\{aligned\}([\s\S]*)\\end\{aligned\}$/.exec(content.trim());
  if(!match||/\\\\\s*\[/.test(match[1]))return [content];
  const rows=[];let row='',braces=0,environments=0,delimiters=0;
  const source=match[1];
  for(let i=0;i<source.length;){
    const tail=source.slice(i),command=/^\\(?:begin\{[^}]+\}|end\{[^}]+\}|[a-zA-Z]+|[^a-zA-Z])/.exec(tail)?.[0];
    if(command){
      if(command==='\\\\'&&!braces&&!environments&&!delimiters){rows.push(row.trim());row='';i+=command.length;continue;}
      if(command.startsWith('\\begin{'))environments++;
      else if(command.startsWith('\\end{'))environments--;
      else if(command==='\\left')delimiters++;
      else if(command==='\\right')delimiters--;
      row+=command;i+=command.length;continue;
    }
    const char=source[i++];
    if(char==='{' )braces++;
    else if(char==='}')braces--;
    if(char==='&'&&!braces&&!environments&&!delimiters)continue;
    row+=char;
  }
  rows.push(row.trim());
  return rows.every(Boolean)&&!braces&&!environments&&!delimiters?rows:[content];
}

function topLevelMathSplit(source,mode) {
  const parts=[];let part='',braces=0,environments=0,delimiters=0;
  for(let i=0;i<source.length;){
    const command=/^\\(?:begin\{[^}]+\}|end\{[^}]+\}|[a-zA-Z]+|[^a-zA-Z])/.exec(source.slice(i))?.[0];
    if(command){
      if(mode==='space'&&!braces&&!environments&&!delimiters&&['\\quad','\\qquad'].includes(command)){parts.push(part.trim());part='';i+=command.length;continue;}
      if(command.startsWith('\\begin{'))environments++;
      else if(command.startsWith('\\end{'))environments--;
      else if(command==='\\left')delimiters++;
      else if(command==='\\right')delimiters--;
      part+=command;i+=command.length;continue;
    }
    const char=source[i++];
    if(char==='{' )braces++;else if(char==='}')braces--;
    if(mode==='equal'&&char==='='&&!braces&&!environments&&!delimiters){parts.push(part.trim());part='';continue;}
    part+=char;
  }
  parts.push(part.trim());return parts.every(Boolean)?parts:[source];
}

// Break between whole displayed expressions, never between an arrow and its
// right-hand value. A continuation equality belongs to its following operand.
export function mathChatGroups(row) {
  return topLevelMathSplit(row,'space').flatMap(part=>{
    const label=/^([\s\S]+?)\s*(\\text\{（[^{}]*）\})$/.exec(part);
    const body=label?label[1].trim():part;
    const equal=topLevelMathSplit(body,'equal');
    const groups=equal.length>2?[`${equal[0]}=${equal[1]}`,...equal.slice(2).map(x=>'='+x)]:[body];
    return label?[...groups,label[2]]:groups;
  });
}

export function projectMathChatBlocks(document) {
  return document.blocks.flatMap((block,blockIndex)=>{
    const content=block.content.trim();
    return (block.type==='math'?mathChatRows(content):[content]).map((row,fragment)=>({blockIndex,fragment,content:row}));
  });
}
