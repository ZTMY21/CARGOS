import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoxSheetsHandler} from '../api/box-sheets.js';

function response(){
  return {
    headers:{},
    setHeader(key,value){this.headers[key]=value;},
    end(value){this.body=JSON.parse(value);}
  };
}
test('la API antigua de CARGOS ENVIADOS rechaza cualquier escritura',async()=>{
  for(const action of ['scan','sync','check']){
    const res=response();
    await createBoxSheetsHandler()({
      method:'POST',
      body:{action,code:'T9000000001'},
      headers:{authorization:'Bearer test',host:'app.example.com'}
    },res);
    assert.equal(res.statusCode,410);
    assert.equal(res.body.error,'IM_LEGACY_GOOGLE_SHEETS_RETIRED');
    assert.equal(res.headers['Cache-Control'],'private, no-store');
  }
});
