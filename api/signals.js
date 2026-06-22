// File: /api/signals.js
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Инициализираме AI извън handler-а
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function getRequestBody(req) {
  if (req.body) return req.body;
  const buffers = [];
  for await (const chunk of req) {
    buffers.push(chunk);
  }
  const data = Buffer.concat(buffers).toString();
  return JSON.parse(data);
}

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Методът не е разрешен.' });
  }

  try {
    const body = await getRequestBody(request);
    const { citizenName, citizenPhone, citizenEmail, rawDescription, imageUrl, latitude, longitude } = body;

    if (!citizenName || !citizenEmail || !rawDescription) {
      return response.status(400).json({ error: 'Име, имейл и описание са задължителни по АПК.' });
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      throw new Error("Липсват конфигурационни ключове за Supabase във Vercel.");
    }

    // Инициализираме модела със строги системни инструкции
    const model = ai.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      systemInstruction: `Ти си висш административен изкуствен интелект към Гражданския инкубатор на град Пловдив. 
Твоята задача е да поемеш суров сигнал от гражданин и да преминеш през три вътрешни роли, преди да върнеш финалния отговор:
1. РЕЦЕПЦИОНИСТ: Анализираш текста, изчистваш вулгарния език (ако има такъв) и коригираш правописните и пунктуационни грешки, запазвайки оригиналния смисъл.
2. АДМИНИСТРАТОР: Извличаш точния адрес в Пловдив, определяш приоритета (Low, Medium, High) и избираш най-подходящата отговорна институция.
3. ПРАВЕН СЪТРУДНИК: Оформяш официално структурирано писмо съгласно изискванията на Административнопроцесуарния кодекс (АПК) на Република България.

Връщай ЕДИНСТВЕНО валиден JSON обект. Без markdown обвивки (без трите кавички \`\`\`json).`,
    });

    const prompt = `Изпълни следните стъпки за обработка на сигнала последователно:

СТЪПКА 1 (Корекция): Коригирай правописа, граматиката и стилистиката на следния текст на български език: "${rawDescription}". Превърни го в културно, ясно и добре структурирано описание.

СТЪПКА 2 (Администрация): Анализираш коригирания текст и извлечи:
- Точен адрес/локация в град Пловдив.
- Ниво на спешност (priority) – избери точно едно от: 'Low', 'Medium', 'High'.
- Отговорна институция (assigned_institution) – избери най-подходящата от следните: 'ОП Чистота', 'ОП Градини и паркове', 'ОП Организация и контрол на транспорта', 'Район Централен', 'Район Южен', 'Район Северен', 'Район Западен', 'Район Източен', 'Район Тракия', 'Община Пловдив'.

СТЪПКА 3 (Правно оформяне): Създай официално писмо-сигнал по чл. 107-111 от АПК. Писмото трябва да съдържа:
- "ДО: [Името на избраната институция]"
- "ОТ: [Три имена на гражданина: ${citizenName}], Имейл: ${citizenEmail}, Тел: ${citizenPhone || 'Не е посочен'}"
- Текст, който официално, сериозно и аргументирано излага проблема и призовава за проверка на място и последващи действия.
- Официален завършек ("С уважение...").

Върни резултата СТРИКТНО като JSON обект със следните полета (и нищо друго):
{
  "corrected_text": "коригираният текст от стъпка 1",
  "location": "извлеченият адрес от стъпка 2",
  "assigned_institution": "избраната институция от стъпка 2",
  "priority": "избраният приоритет от стъпка 2",
  "official_letter": "официалното писмо от стъпка 3"
}`;

   // =========================================================================
    // ОБНОВЕН БЛОК: ИЗВЛИЧАНЕ НА ДАННИ ОТ GEMINI СЪС ЗАЩИТА ОТ ГРЕШКИ 503
    // =========================================================================
    let responseText = "";
    const maxRetries = 3; // Брой опити, които системата ще направи

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const aiResponse = await model.generateContent(prompt);
        // Взимаме текста и веднага изчистваме излишните интервали по краищата
        responseText = aiResponse.response.text().trim(); 
        
        // Ако заявката премине успешно, прекъсваме цикъла (retry) и продължаваме напред
        break; 
      } catch (aiError) {
        console.error(`Отказ на Gemini при опит ${attempt} от общо ${maxRetries}:`, aiError);
        
        // Ако това е бил последният опит и все още дава грешка — я хвърляме нагоре към catch блока
        if (attempt === maxRetries) {
          throw aiError; 
        }
        
        // Преди следващия опит правим малка пауза от 800 милисекунди (за да изчакаме сървъра)
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }

    // Твоята съществуваща логика за изчистване на JSON от Markdown тагове (изпълнява се след успешния цикъл)
    if (responseText.startsWith("```")) {
      responseText = responseText.replace(/^```json|```$/g, "").trim();
    }
    // =========================================================================

    const structuredData = JSON.parse(responseText);
    // ==========================================
    // АВТОМАТИЧНО ГЕОКОДИРАНЕ ЧРЕЗ OPENSTREETMAP (NOMINATIM)
    // ==========================================
let finalLat = body.latitude;
    let finalLng = body.longitude;

// Ако потребителят НЕ е цъкнал на картата, но Gemini е извлякъл текстов адрес
    if (!finalLat || !finalLng) {
      try {
        const cleanLocation = structuredData.location ? structuredData.location.trim() : "";
        
        // Махаме съкращения и номера, за да извлечем СЛЕДВАЩОТО по ред чисто име (напр. от "бул. Копривщица 19" -> "Копривщица")
        // Това е ключово за OpenStreetMap, когато булевардите са разделени на платна в базата данни
        const pureName = cleanLocation
          .replace(/^(ул\.|улица|бул\.|булевард|пл\.|площад|ж\.к\.|квартал)\s+/i, "") // Премахва типа на обекта
          .replace(/\s+\d+\s*$/, "") // Премахва номера накрая (ако има такъв)
          .trim();
        
        // Масив с варианти за търсене - от най-детайлен към най-общ
        const searchAttempts = [
          // Опит 1: Точният адрес от ИИ (напр. "бул. Копривщица 19, Пловдив, България")
          `${cleanLocation}, Пловдив, България`,
          
          // Опит 2: Премахваме номера накрая, за да хванем поне самата улица (напр. "бул. Копривщица, Пловдив, България")
          `${cleanLocation.replace(/\s+\d+\s*$/, "")}, Пловдив, България`,
          
          // Опит 3: Ключово търсене само по чисто име (напр. "Копривщица, Пловдив, България")
          // Ако pureName е празен стринг (поради някаква причина), този опит се пропуска в цикъла
          pureName ? `${pureName}, Пловдив, България` : null
        ].filter(Boolean); // Филтрираме null стойностите, ако Опит 3 е празен

        // Въртим цикъл през наличните опити, докато някой не върне координати
        for (const queryText of searchAttempts) {
          if (finalLat && finalLng) break; // Ако вече сме намерили точка в предния опит - спираме

          console.log(`Пробвам геокодиране в OSM с: "${queryText}"`);
          const searchQuery = encodeURIComponent(queryText);
          
          // Извикваме безплатното Nominatim API на OpenStreetMap
          const geoResponse = await fetch(`https://nominatim.openstreetmap.org/search?q=${searchQuery}&format=json&limit=1`, {
            headers: { 'User-Agent': 'PlovdivSignalsCitizenIncubator/1.0' }
          });

          if (geoResponse.ok) {
            const geoData = await geoResponse.json();
            if (geoData && geoData.length > 0) {
              finalLat = parseFloat(geoData[0].lat);
              finalLng = parseFloat(geoData[0].lon);
              console.log(`🎯 Успех! Намерени координати: ${finalLat}, ${finalLng}`);
              break; // Прекъсваме цикъла, защото открихме локацията успешно
            }
          }
          
          // Малка пауза от 200ms между заявките, за да спазим изискванията на OSM API
          await new Promise(resolve => setTimeout(resolve, 200));
        }

      } catch (geoError) {
        console.error("Грешка при автоматично геокодиране:", geoError);
        // Не хвърляме грешка, за да може сигналът все пак да се запише в базата данни
      }
    }
    // ==========================================
    // ДИРЕКТЕН И СИГУРЕН ЗАПИС В SUPABASE ЧРЕЗ HTTP REST API
    // ==========================================
    try {
      const supabaseUrl = process.env.SUPABASE_URL.replace(/\/$/, ""); 
      const supabaseKey = process.env.SUPABASE_ANON_KEY;
      
      const payload = { 
        citizen_name: citizenName,
        citizen_phone: citizenPhone || null,
        citizen_email: citizenEmail,
        raw_description: rawDescription, 
        image_url: imageUrl || null,
        corrected_text: structuredData.corrected_text,
        location: structuredData.location,
        assigned_institution: structuredData.assigned_institution,
        // Проверяваме дали ИИ е върнал валиден приоритет, ако не - слагаме по подразбиране 'Medium'
        priority: ['Low', 'Medium', 'High'].includes(structuredData.priority) ? structuredData.priority : 'Medium',
        official_letter: structuredData.official_letter,
        status: 'Подаден',
        
        // НОВИТЕ КОЛОНИ ЗА ГЕО-ЛОКАЦИЯ (АВТОМАТИЧНИ ИЛИ ОТ КАРТАТА):
        latitude: finalLat || null,
        longitude: finalLng || null
      };

      console.log("Опит за директна HTTP заявка към:", `${supabaseUrl}/rest/v1/signals`);

      const supabaseResponse = await fetch(`${supabaseUrl}/rest/v1/signals`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(payload)
      });

      if (!supabaseResponse.ok) {
        const errorText = await supabaseResponse.text();
        console.error("Supabase API върна грешка:", supabaseResponse.status, errorText);
        throw new Error(`Supabase HTTP Error ${supabaseResponse.status}: ${errorText}`);
      }

      const insertedData = await supabaseResponse.json();
      return response.status(200).json({ success: true, data: insertedData[0] });

    } catch (supabaseRestError) {
      console.error('ПОДРОБНА ДИАГНОСТИКА НА МРЕЖАТА:', {
        message: supabaseRestError.message,
        stack: supabaseRestError.stack,
        cause: supabaseRestError.cause
      });
      throw new Error(`Проблем с базата данни: ${supabaseRestError.message}`);
    }

  } catch (err) {
    console.error('Критична грешка в ИИ Модула:', err);
    return response.status(500).json({ success: false, error: err.message || 'Вътрешна системна грешка.' });
  }
}
