export const validDuration=value=>Number.isInteger(value)&&value>=5&&value<=480;
export function normalizeDurationOptions(value,defaultDuration){
 if(!validDuration(defaultDuration))throw Error('Choose a duration between 5 and 480 minutes.');
 if(value===undefined||value===null)return null;
 if(!Array.isArray(value)||value.length<1||value.length>4||value.some(duration=>!validDuration(duration))||new Set(value).size!==value.length||!value.includes(defaultDuration))throw Error('Choose up to four different durations, including the default.');
 return [...value];
}
export function allowedDurations(config){const options=normalizeDurationOptions(config.durationOptions,config.duration);return options??[config.duration];}
export function selectDuration(config,selected=undefined){const duration=selected===undefined?config.duration:selected;if(!validDuration(duration)||!allowedDurations(config).includes(duration))throw Error('Choose an available meeting duration.');return duration;}
