/** Called only after the existing partner HMAC and rate-limit middleware. */
export async function routeTransfers(service,app,req,path,{raw}={}){
 const keyId=req.headers['x-gp-key-id'];
 if(path==='/v1/transfers'){
  if(req.method!=='POST')return{status:405,body:{code:'METHOD_NOT_ALLOWED'}};
  const body=await service.create(app,{keyId,requestId:req.headers['x-gp-request-id'],raw});
  return{status:body.state==='PENDING'?202:200,body};
 }
 const one=path.match(/^\/v1\/transfers\/([A-Za-z0-9_-]{1,128})$/);
 if(one){if(req.method!=='GET')return{status:405,body:{code:'METHOD_NOT_ALLOWED'}};return{status:200,body:await service.read(app,one[1],{keyId})};}
 // Path cursors preserve the existing exact signed path contract (no query string).
 const ledger=path.match(/^\/v1\/transfer-ledger\/([A-Za-z0-9_-]{1,128})\/(0|[1-9][0-9]{0,18})\/(latest|0|[1-9][0-9]{0,18})$/);
 if(ledger){if(req.method!=='GET')return{status:405,body:{code:'METHOD_NOT_ALLOWED'}};return{status:200,body:await service.statement(app,{keyId,bindingId:ledger[1],after:ledger[2],through:ledger[3]==='latest'?null:ledger[3]})};}
 return null;
}
