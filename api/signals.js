// File: /api/signals.js
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/generative-ai';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export default async function handler(request, response) {
  // Позволяваме само POST заявки за сигурност
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Методът не е разрешен. Използвайте POST.' });
  }

  try {
    const { citizenName, citizenPhone, citizenEmail, rawDescription, imageUrl } = request.body;

    if (!citizenName || !citizenEmail || !rawDescription) {
      return response.status(400).json({ error: 'Име, имейл и описание са задължителни по АПК.' });
    }

    const model = ai.getGenerativeModel({ 
      model: "gemini-2.0-flash",
      systemInstruction: "Ти си софтуерен модул. Връщай ЕДИНСТВЕНО валиден JSON. Без markdown (```json)." 
    });

    const prompt = `Анализирай сигнал за Пловдив. Подател: "${citizenName}", Сигнал: "${rawDescription}". Върни JSON с полета: corrected_text, location, assigned_institution (избери най-близкото ОП или Район), priority (Low, Medium, High), official_letter (текст по АПК).`;

    const aiResponse = await model.generateContent(prompt);
    let responseText = aiResponse.response.text().trim();
    
    if (responseText.startsWith("```")) {
      responseText = responseText.replace(/^```json|```$/g, "").trim();
    }

    const structuredData = JSON.parse(responseText);

    const { data, error } = await supabase
      .from('signals')
      .insert([
        { 
          citizen_name: citizenName,
          citizen_phone: citizenPhone || null,
          citizen_email: citizenEmail,
          raw_description: rawDescription, 
          image_url: imageUrl || null,
          corrected_text: structuredData.corrected_text,
          location: structuredData.location,
          assigned_institution: structuredData.assigned_institution,
          priority: ['Low', 'Medium', 'High'].includes(structuredData.priority) ? structuredData.priority : 'Medium',
          official_letter: structuredData.official_letter,
          status: 'Подаден'
        }
      ])
      .select();

    if (error) throw new Error(error.message);

    return response.status(200).json({ success: true, data: data[0] });

  } catch (err) {
    console.error(err);
    return response.status(500).json({ success: false, error: err.message });
  }
}
