import {parsePhoneNumberFromString,getCountries} from 'libphonenumber-js';
import {countries} from '../public/countries.js';
import {fail} from './service.mjs';
export const normalizeSearch=value=>String(value||'').normalize('NFKD').replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export function internationalPhone(value,country){
 if(!getCountries().includes(country))fail(400,'اختر دولة رقم الهاتف');
 const raw=String(value||'').replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/^\s*00/,'+');
 const phone=parsePhoneNumberFromString(raw,{defaultCountry:country,extract:false});
 if(!phone||phone.ext||!phone.isPossible())fail(400,'رقم الهاتف غير مكتمل أو لا يطابق كود الدولة؛ راجع الرقم');
 return phone.number;
}
export function nationality(code){const row=countries.find(c=>c.code===code);if(!row)fail(400,'اختر الجنسية من القائمة');return row.name;}
