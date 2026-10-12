// Usage: node restore.js storage/backups/<file>.json   (stop the server first)
const fs=require('fs'),path=require('path');const f=process.argv[2];
if(!f||!fs.existsSync(f)){console.log('Usage: node restore.js <backup-file>');process.exit(1)}
let d;try{d=JSON.parse(fs.readFileSync(f,'utf8'));if(!d.org||!Array.isArray(d.teams)||!Array.isArray(d.questions))throw new Error('not a Bizilytics database')}catch(e){console.log('Backup invalid, nothing changed:',e.message);process.exit(1)}
const DB=path.join(__dirname,'storage','db.json');if(fs.existsSync(DB))fs.copyFileSync(DB,DB.replace('.json','-before-restore-'+Date.now()+'.json'));
fs.copyFileSync(f,DB);console.log('Restored',f,'-> storage/db.json ('+d.teams.length+' teams, '+d.questions.length+' questions). Start the server again.');
