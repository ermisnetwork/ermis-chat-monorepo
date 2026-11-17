global.Image = class FixtureImage { set src(value) {} };
const test=require('node:test');const assert=require('node:assert/strict');const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');const {AttachmentList}=require('../dist/index.cjs');
for(const type of ['file','image']) for(const [status,label]of [['failed','Upload failed'],['paused','Upload paused']])test(`${type} ${status} attachment at99 has a settled label instead of upload spinner`,()=>{
 const html=renderToStaticMarkup(React.createElement(AttachmentList,{attachments:[{type,image_url:type==='image'?'blob:fixture':undefined,file_name:'fixture.txt',asset_url:'blob:fixture',upload_status:status,upload_progress:99,upload_error_status:403}]}));
 assert.ok(html.includes(label));assert.ok(!html.includes('99%'));assert.ok(!html.includes('ermis-e2ee-attachment-spinner'));if(status==='failed')assert.ok(html.includes('403'));
});
