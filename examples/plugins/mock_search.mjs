export default {
 apiVersion:1,id:'mock-search',capabilities:['search'],
 setup(){return {search:async request=>({status:'ok',mock:true,query:String(request.query||'').slice(0,100),results:[{title:'Synthetic plugin example, not factual evidence',url:'https://example.com/'}]})};}
};
