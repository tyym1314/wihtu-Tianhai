import {parseBuildArguments} from './build-config.mjs';
try{console.log(parseBuildArguments(process.argv.slice(2)).flavor);}
catch(error){console.error('Player APK configuration rejected: '+error.message);process.exitCode=1;}
