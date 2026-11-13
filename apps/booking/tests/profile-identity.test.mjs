import test from 'node:test';
import assert from 'node:assert/strict';
import {profileWebsite,profileName} from '../public/profile-identity.js';
test('profile identity accepts names or normalised website input without fetching it',()=>{
 assert.equal(profileWebsite(' globex.example '),'https://globex.example/');assert.equal(profileName('',profileWebsite('www.globex.example')),'Globex');assert.equal(profileName('Riley',''),'Riley');assert.equal(profileWebsite(''),'');
 for(const input of ['javascript:alert(1)','https://secret@example.com','https://u:p@example.com','https://','not a url'])assert.throws(()=>profileWebsite(input));
});
