// Shared browser/server form contract. Never derive saved answers from a later
// meeting-type definition: each booking retains this normalized snapshot.
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const types=new Set(['text','textarea','select','checkbox']);
const invalid=message=>{throw Error(message);};
export function normalizeQuestions(config={}){
  if(config.questions==null){
    const label=typeof config.question==='string'?config.question.trim():'';
    return label?[{id:'legacy',type:'textarea',label,required:config.required===true}]:[];
  }
  if(!Array.isArray(config.questions)||config.questions.length>8)invalid('Use up to eight booking questions.');
  const ids=new Set();
  return config.questions.map(question=>{
    if(!object(question)||Object.keys(question).some(key=>!['id','type','label','required','options'].includes(key)))invalid('Choose valid booking question fields.');
    const {id,type,required}=question;
    if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)||ids.has(id))invalid('Use unique booking question identifiers.');
    ids.add(id);
    if(!types.has(type)||typeof question.label!=='string'||!question.label.trim()||question.label.length>160||typeof required!=='boolean')invalid('Add a label and supported type for every question.');
    const result={id,type,label:question.label.trim(),required};
    if(type==='select'){
      if(!Array.isArray(question.options)||!question.options.length||question.options.length>12||question.options.some(option=>typeof option!=='string'||!option.trim()||option.length>160))invalid('Give a choice question between one and twelve options.');
      result.options=question.options.map(option=>option.trim());
      if(new Set(result.options).size!==result.options.length)invalid('Use distinct choices for each question.');
    }else if(question.options!==undefined)invalid('Only choice questions support options.');
    return result;
  });
}
/** Bind a guest submission to exactly the form they reviewed, including its
 * invitation allowance. Canonical field order is independent of object order. */
export async function intakeRevision(config={}){
  const questions=normalizeQuestions(config),extraGuestsLimit=config.extraGuestsLimit??0;
  if(!Number.isInteger(extraGuestsLimit)||extraGuestsLimit<0||extraGuestsLimit>5)invalid('Check the additional guest limit.');
  const approval=config.requiresApproval?{approval:{required:true,expiryMinutes:config.approvalExpiryMinutes??1440}}:{};
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({questions,extraGuestsLimit,...approval})));
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
export function validGuestEmail(value){
  if(typeof value!=='string'||value.length>254||/[\u0000-\u0020\u007f]/.test(value))return false;
  const parts=value.split('@');
  return parts.length===2&&parts[0].length<=64&&
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(parts[0])&&
    parts[1].includes('.')&&parts[1].split('.').every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
export function validateIntake(config={},data={}){
  const questionSnapshot=normalizeQuestions(config),legacy=config.questions==null;
  if(data.answers!==undefined&&!object(data.answers))invalid('Check your booking answers.');
  if(data.answer!==undefined&&typeof data.answer!=='string')invalid('Check your booking answer.');
  const submitted=data.answers??{},answer=(data.answer??'').trim(),known=new Set(questionSnapshot.map(question=>question.id));
  if(Object.keys(submitted).some(id=>!known.has(id)))invalid('The booking questions changed. Refresh the page and check your answers.');
  if(!legacy&&answer)invalid('Check your booking answers.');
  if(legacy&&answer&&Object.hasOwn(submitted,'legacy')&&submitted.legacy!==answer)invalid('Check your booking answer.');
  if(legacy&&answer&&!known.has('legacy'))invalid('This meeting has no preparation question.');
  const answers={};
  for(const question of questionSnapshot){
    const value=legacy&&question.id==='legacy'&&answer?answer:(Object.hasOwn(submitted,question.id)?submitted[question.id]:undefined);
    if(value===undefined||value===''){
      if(question.required)invalid(`Answer “${question.label}”.`);
      continue;
    }
    if(question.type==='checkbox'){
      if(typeof value!=='boolean'||question.required&&!value)invalid(`Confirm “${question.label}”.`);
      answers[question.id]=value;
    }else{
      if(typeof value!=='string'||value.length>(question.type==='text'?500:2000))invalid(`Check “${question.label}”.`);
      const normalized=value.trim();
      if(!normalized){if(question.required)invalid(`Answer “${question.label}”.`);continue;}
      if(question.type==='select'&&!question.options.includes(normalized))invalid(`Choose an option for “${question.label}”.`);
      answers[question.id]=normalized;
    }
  }
  const limit=config.extraGuestsLimit??0,guests=data.additionalGuests??[];
  if(!Number.isInteger(limit)||limit<0||limit>5||!Array.isArray(guests)||guests.length>5||guests.some(value=>typeof value!=='string'))invalid('Check the additional guests.');
  const additionalGuests=[...new Set(guests.map(value=>value.trim().toLowerCase()))].filter(value=>value!==String(data.email??'').trim().toLowerCase());
  if(additionalGuests.some(value=>!validGuestEmail(value)))invalid('Enter a valid email for each additional guest.');
  if(additionalGuests.length>limit)invalid(limit?`Add up to ${limit} additional guests.`:'This meeting does not accept additional guests.');
  return {answers,questionSnapshot,additionalGuests};
}
export function intakeDescription(booking){
  if(!Array.isArray(booking.questionSnapshot))return booking.answer?`Guest note: ${booking.answer}\n\n`:'';
  return booking.questionSnapshot.flatMap(question=>{
    const value=booking.answers?.[question.id];
    return value===undefined?[]:[`${question.label}\n${typeof value==='boolean'?(value?'Yes':'No'):value}`];
  }).join('\n\n')+(Object.keys(booking.answers??{}).length?'\n\n':'');
}
