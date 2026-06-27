import { useState, useEffect, useRef, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";

// ─────────────────────────────────────────────────────────────────────────────
// SUPABASE CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const SUPA_URL = "https://tsjyuositikugsbrctcu.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRzanl1b3NpdGlrdWdzYnJjdGN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyOTc0MjYsImV4cCI6MjA5Nzg3MzQyNn0.Q27bXcQx10fHE5aGBVMiXbAYHKRMyXT6bRxtSs2UWos";

async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      "apikey": SUPA_KEY,
      "Authorization": `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      "Prefer": opts.prefer ?? "return=representation",
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE API (via Netlify Function)
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude(messages, maxTokens = 1500) {
  const resp = await fetch("/.netlify/functions/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, messages }),
  });
  if (!resp.ok) throw new Error("Claude API fout");
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  return (data.content ?? []).map(b => b.text ?? "").join("");
}

// DB helpers
const db = {
  // Clients
  getClients: (trainerId) => sbFetch(`clients?select=*&trainer_id=eq.${trainerId}&order=created_at.desc`),
  getAllClients: () => sbFetch("clients?select=*&order=created_at.desc"),
  insertClient: (c) => sbFetch("clients", {
    method: "POST",
    headers: { "Prefer": "return=representation" },
    body: JSON.stringify({
      id: c.id, name: c.name, goal: c.goal, frequency: c.frequency,
      injuries: c.injuries, preferred_exercises: c.preferredExercises,
      disliked_exercises: c.dislikedExercises, current_focus: c.currentFocus,
      notes: c.notes, created_at: c.createdAt, ai_analyses: c.aiAnalyses ?? [],
      trainer_id: c.trainerId ?? "teun",
    }),
  }),
  updateClient: (c) => sbFetch(`clients?id=eq.${c.id}`, {
    method: "PATCH",
    headers: { "Prefer": "return=representation" },
    body: JSON.stringify({
      name: c.name, goal: c.goal, frequency: c.frequency,
      injuries: c.injuries, preferred_exercises: c.preferredExercises,
      disliked_exercises: c.dislikedExercises, current_focus: c.currentFocus,
      notes: c.notes, ai_analyses: c.aiAnalyses ?? [],
      trainer_id: c.trainerId,
    }),
  }),
  deleteClient: (id) => sbFetch(`clients?id=eq.${id}`, { method: "DELETE", prefer: "" }),

  // Trainings
  getTrainings: (clientId) => sbFetch(`trainings?client_id=eq.${clientId}&order=date.desc,created_at.desc`),
  insertTraining: (t, clientId) => sbFetch("trainings", {
    method: "POST",
    headers: { "Prefer": "return=representation" },
    body: JSON.stringify({
      id: t.id, client_id: clientId, date: t.date, energy: t.energy,
      complaints: t.complaints, notes: t.notes, next_focus: t.nextFocus,
      exercises: t.exercises ?? [],
    }),
  }),
  updateTraining: (t) => sbFetch(`trainings?id=eq.${t.id}`, {
    method: "PATCH",
    headers: { "Prefer": "return=representation" },
    body: JSON.stringify({
      date: t.date, energy: t.energy, complaints: t.complaints,
      notes: t.notes, next_focus: t.nextFocus, exercises: t.exercises ?? [],
    }),
  }),
  deleteTraining: (id) => sbFetch(`trainings?id=eq.${id}`, { method: "DELETE", prefer: "" }),

  // InBody metingen
  getInbody: (clientId) => sbFetch(`inbody_measurements?client_id=eq.${clientId}&order=date.desc,created_at.desc`),
  insertInbody: (m, clientId) => sbFetch("inbody_measurements", {
    method: "POST",
    headers: { "Prefer": "return=representation" },
    body: JSON.stringify({ id: m.id, client_id: clientId, date: m.date, data: m.data ?? {} }),
  }),
  deleteInbody: (id) => sbFetch(`inbody_measurements?id=eq.${id}`, { method: "DELETE", prefer: "" }),

  // Equipment
  getEquipment: () => sbFetch("equipment?select=*&order=name.asc"),
  upsertEquipment: (eq) => sbFetch("equipment", {
    method: "POST", prefer: "return=representation",
    headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ id: eq.id, name: eq.name, exercises: eq.exercises ?? [] }),
  }),
  deleteEquipment: (id) => sbFetch(`equipment?id=eq.${id}`, { method: "DELETE", prefer: "" }),
  replaceAllEquipment: async (eqList) => {
    await sbFetch("equipment", { method: "DELETE", prefer: "", headers: { "Prefer": "" } });
    for (const eq of eqList) await db.upsertEquipment(eq);
  },
};

// Convert DB row → app object
function rowToClient(row, trainings = [], inbody = []) {
  return {
    id: row.id, name: row.name, goal: row.goal, frequency: row.frequency ?? "",
    injuries: row.injuries ?? "", preferredExercises: row.preferred_exercises ?? "",
    dislikedExercises: row.disliked_exercises ?? "", currentFocus: row.current_focus ?? "",
    notes: row.notes ?? "", createdAt: row.created_at, aiAnalyses: row.ai_analyses ?? [],
    trainerId: row.trainer_id ?? "teun",
    trainings, inbody,
  };
}
function rowToInbody(row) {
  return { id: row.id, date: row.date, data: row.data ?? {} };
}
function rowToTraining(row) {
  return {
    id: row.id, date: row.date, energy: row.energy ?? "", complaints: row.complaints ?? "",
    notes: row.notes ?? "", nextFocus: row.next_focus ?? "", exercises: row.exercises ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT EQUIPMENT
// ─────────────────────────────────────────────────────────────────────────────
const MUSCLE_GROUPS = ["Borst","Rug","Benen","Schouders","Armen","Core","Full body"];
const DEFAULT_EQUIPMENT = [
  { id:"eq1", name:"Dumbbells (t/m 40kg)", exercises:[
    // Borst
    {id:"d1",name:"Dumbbell bench press",muscles:["Borst"]},
    {id:"d2",name:"Dumbbell incline press",muscles:["Borst"]},
    {id:"d3",name:"Dumbbell fly",muscles:["Borst"]},
    {id:"d4",name:"Dumbbell incline fly",muscles:["Borst"]},
    // Rug
    {id:"d5",name:"Dumbbell row (1 arm)",muscles:["Rug"]},
    {id:"d6",name:"Dumbbell renegade row",muscles:["Rug","Core"]},
    {id:"d7",name:"Dumbbell shrug",muscles:["Rug"]},
    {id:"d8",name:"Dumbbell pullover",muscles:["Rug","Borst"]},
    // Benen
    {id:"d9",name:"Dumbbell RDL",muscles:["Benen"]},
    {id:"d10",name:"Dumbbell goblet squat",muscles:["Benen"]},
    {id:"d11",name:"Dumbbell lunge",muscles:["Benen"]},
    {id:"d12",name:"Dumbbell split squat",muscles:["Benen"]},
    {id:"d13",name:"Dumbbell step-up",muscles:["Benen"]},
    {id:"d14",name:"Dumbbell hip thrust",muscles:["Benen"]},
    {id:"d15",name:"Dumbbell calf raise",muscles:["Benen"]},
    // Schouders
    {id:"d16",name:"Dumbbell shoulder press",muscles:["Schouders"]},
    {id:"d17",name:"Lateral raise",muscles:["Schouders"]},
    {id:"d18",name:"Front raise",muscles:["Schouders"]},
    {id:"d19",name:"Dumbbell reverse fly",muscles:["Schouders","Rug"]},
    {id:"d20",name:"Arnold press",muscles:["Schouders"]},
    // Armen
    {id:"d21",name:"Dumbbell curl",muscles:["Armen"]},
    {id:"d22",name:"Hammer curl",muscles:["Armen"]},
    {id:"d23",name:"Incline curl",muscles:["Armen"]},
    {id:"d24",name:"Dumbbell tricep kickback",muscles:["Armen"]},
    {id:"d25",name:"Dumbbell overhead tricep extension",muscles:["Armen"]},
    {id:"d26",name:"Dumbbell skullcrusher",muscles:["Armen"]},
  ]},
  { id:"eq2", name:"Squat rack + Barbell", exercises:[
    // Benen
    {id:"b1",name:"Barbell squat",muscles:["Benen"]},
    {id:"b2",name:"Front squat",muscles:["Benen"]},
    {id:"b3",name:"Barbell RDL",muscles:["Benen","Rug"]},
    {id:"b4",name:"Barbell deadlift",muscles:["Benen","Rug"]},
    {id:"b5",name:"Barbell hip thrust",muscles:["Benen"]},
    {id:"b6",name:"Barbell lunge",muscles:["Benen"]},
    {id:"b7",name:"Good morning",muscles:["Benen","Rug"]},
    // Rug
    {id:"b8",name:"Barbell row",muscles:["Rug"]},
    {id:"b9",name:"Pendlay row",muscles:["Rug"]},
    {id:"b10",name:"Rack pull",muscles:["Rug","Benen"]},
    // Borst
    {id:"b11",name:"Barbell bench press",muscles:["Borst"]},
    {id:"b12",name:"Barbell incline bench press",muscles:["Borst"]},
    // Schouders
    {id:"b13",name:"Barbell overhead press",muscles:["Schouders"]},
    {id:"b14",name:"Push press",muscles:["Schouders"]},
    // Armen
    {id:"b15",name:"Barbell curl",muscles:["Armen"]},
    {id:"b16",name:"Close grip bench press",muscles:["Armen","Borst"]},
    // Squat rack als rek
    {id:"b17",name:"Pull-up",muscles:["Rug"]},
    {id:"b18",name:"Chin-up",muscles:["Rug","Armen"]},
    {id:"b19",name:"Hanging knee raise",muscles:["Core"]},
    {id:"b20",name:"Hanging leg raise",muscles:["Core"]},
    {id:"b21",name:"Dead hang",muscles:["Rug"]},
  ]},
  { id:"eq3", name:"Lat pull-down", exercises:[
    // Rug
    {id:"l1",name:"Lat pulldown breed grip",muscles:["Rug"]},
    {id:"l2",name:"Lat pulldown smal grip",muscles:["Rug"]},
    {id:"l3",name:"Lat pulldown underhand grip",muscles:["Rug","Armen"]},
    {id:"l4",name:"Lat pulldown neutral grip",muscles:["Rug"]},
    {id:"l5",name:"Straight arm pulldown",muscles:["Rug"]},
    {id:"l6",name:"Seated cable row breed",muscles:["Rug"]},
    {id:"l7",name:"Seated cable row smal",muscles:["Rug"]},
    {id:"l8",name:"Single arm cable row",muscles:["Rug"]},
    // Schouders/rug
    {id:"l9",name:"Face pull",muscles:["Schouders","Rug"]},
    {id:"l10",name:"Cable rear delt fly",muscles:["Schouders","Rug"]},
    // Borst
    {id:"l11",name:"Cable fly laag naar hoog",muscles:["Borst"]},
    {id:"l12",name:"Cable fly hoog naar laag",muscles:["Borst"]},
    // Armen
    {id:"l13",name:"Cable bicep curl",muscles:["Armen"]},
    {id:"l14",name:"Cable hammer curl",muscles:["Armen"]},
    {id:"l15",name:"Cable tricep pushdown",muscles:["Armen"]},
    {id:"l16",name:"Cable overhead tricep extension",muscles:["Armen"]},
    {id:"l17",name:"Cable lateral raise",muscles:["Schouders"]},
    // Core
    {id:"l18",name:"Cable woodchop",muscles:["Core"]},
    {id:"l19",name:"Cable crunch",muscles:["Core"]},
  ]},
  { id:"eq4", name:"Leg press", exercises:[
    {id:"lp1",name:"Leg press (breed, voeten hoog)",muscles:["Benen"]},
    {id:"lp2",name:"Leg press (smal, voeten laag)",muscles:["Benen"]},
    {id:"lp3",name:"Leg press (één been)",muscles:["Benen"]},
    {id:"lp4",name:"Calf raise op leg press",muscles:["Benen"]},
  ]},
  { id:"eq5", name:"Leg extension / Leg curl", exercises:[
    {id:"le1",name:"Leg extension",muscles:["Benen"]},
    {id:"le2",name:"Leg curl (liggend)",muscles:["Benen"]},
    {id:"le3",name:"Leg curl (één been)",muscles:["Benen"]},
  ]},
  { id:"eq6", name:"Kettlebells", exercises:[
    {id:"k1",name:"Kettlebell swing",muscles:["Benen","Rug"]},
    {id:"k2",name:"Kettlebell goblet squat",muscles:["Benen"]},
    {id:"k3",name:"Kettlebell deadlift",muscles:["Benen","Rug"]},
    {id:"k4",name:"Kettlebell Turkish get-up",muscles:["Full body"]},
    {id:"k5",name:"Kettlebell press",muscles:["Schouders"]},
    {id:"k6",name:"Kettlebell row",muscles:["Rug"]},
    {id:"k7",name:"Kettlebell lunge",muscles:["Benen"]},
    {id:"k8",name:"Kettlebell halo",muscles:["Schouders","Core"]},
  ]},
  { id:"eq7", name:"Verstelbaar bankje", exercises:[
    {id:"bk1",name:"Dip (aan bankje)",muscles:["Armen","Borst"]},
    {id:"bk2",name:"Bulgarian split squat",muscles:["Benen"]},
    {id:"bk3",name:"Step-up",muscles:["Benen"]},
    {id:"bk4",name:"Decline push-up",muscles:["Borst"]},
    {id:"bk5",name:"Incline curl (op bankje)",muscles:["Armen"]},
    {id:"bk6",name:"Hip thrust (op bankje)",muscles:["Benen"]},
  ]},
  { id:"eq8", name:"Mat / Bodyweight", exercises:[
    {id:"m1",name:"Push-up",muscles:["Borst"]},
    {id:"m2",name:"Diamond push-up",muscles:["Armen","Borst"]},
    {id:"m3",name:"Pike push-up",muscles:["Schouders"]},
    {id:"m4",name:"Plank",muscles:["Core"]},
    {id:"m5",name:"Side plank",muscles:["Core"]},
    {id:"m6",name:"Hollow body hold",muscles:["Core"]},
    {id:"m7",name:"Dead bug",muscles:["Core"]},
    {id:"m8",name:"Glute bridge",muscles:["Benen"]},
    {id:"m9",name:"Hip thrust (bodyweight)",muscles:["Benen"]},
    {id:"m10",name:"Bodyweight squat",muscles:["Benen"]},
    {id:"m11",name:"Reverse lunge",muscles:["Benen"]},
    {id:"m12",name:"Mountain climber",muscles:["Core","Full body"]},
    {id:"m13",name:"Burpee",muscles:["Full body"]},
    {id:"m14",name:"Superman",muscles:["Rug"]},
    {id:"m15",name:"Bird dog",muscles:["Core","Rug"]},
  ]},
];

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const GOAL_OPTIONS = [
  {value:"afvallen",label:"Afvallen"},{value:"spieropbouw",label:"Spieropbouw"},
  {value:"conditie",label:"Conditie verbeteren"},{value:"sterker",label:"Sterker worden"},
  {value:"algemeen",label:"Algemene fitheid"},
];
const GOAL_COLORS = {
  afvallen:{bg:"#1a3a2a",text:"#4ade80",border:"#166534"},
  spieropbouw:{bg:"#1e3a5f",text:"#60a5fa",border:"#1e40af"},
  conditie:{bg:"#3b1f3b",text:"#e879f9",border:"#7e22ce"},
  sterker:{bg:"#3b2200",text:"#fb923c",border:"#c2410c"},
  algemeen:{bg:"#2a2a1a",text:"#facc15",border:"#a16207"},
};
const ENERGY_LABELS = ["","💀 Uitgeput","😓 Vermoeid","😐 Normaal","💪 Goed","🔥 Top"];
const rpeColor = (v) => { const n=Number(v); if(!n) return "#6b7280"; if(n<=5) return "#4ade80"; if(n<=7) return "#facc15"; if(n<=8) return "#fb923c"; return "#f87171"; };
const techStars = (v) => v ? "★".repeat(Number(v))+"☆".repeat(5-Number(v)) : "—";
const fmtDate  = (iso) => { if(!iso) return "—"; return new Date(iso+(iso.length===10?"T12:00:00":"")).toLocaleDateString("nl-NL",{day:"numeric",month:"long",year:"numeric"}); };
const fmtShort = (iso) => { if(!iso) return ""; return new Date(iso+(iso.length===10?"T12:00:00":"")).toLocaleDateString("nl-NL",{day:"numeric",month:"short"}); };
const uid = () => Date.now().toString()+Math.random().toString(36).slice(2);

const blankClient   = () => ({id:uid(),name:"",goal:"algemeen",frequency:"",injuries:"",preferredExercises:"",dislikedExercises:"",currentFocus:"",notes:"",createdAt:new Date().toISOString(),trainings:[],aiAnalyses:[]});
const blankExercise = () => ({id:uid(),name:"",sets:"",reps:"",weight:"",rpe:"",technique:"",note:"",setData:[blankSet()]});
const blankSet = () => ({id:uid(),reps:"",weight:"",rpe:""});
const blankTraining = () => ({id:uid(),date:new Date().toISOString().slice(0,10),energy:"",complaints:"",notes:"",nextFocus:"",exercises:[blankExercise()]});

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN
// ─────────────────────────────────────────────────────────────────────────────
const C = {bg:"#0c0e14",surface:"#13161f",surfaceHi:"#181d29",border:"#1e2738",borderHi:"#2a3a54",text:"#e2e8f0",textMid:"#94a3b8",textLow:"#475569",accent:"#3b82f6",accentDim:"#1e3a5f",green:"#4ade80",red:"#f87171",yellow:"#facc15",orange:"#fb923c"};
const T = {
  app:{minHeight:"100vh",background:C.bg,color:C.text,fontFamily:"'Inter',system-ui,-apple-system,sans-serif",fontSize:14},
  header:{background:C.surface,borderBottom:`1px solid ${C.border}`,padding:"0 28px",display:"flex",alignItems:"center",justifyContent:"space-between",height:58,position:"sticky",top:0,zIndex:100},
  main:{maxWidth:960,margin:"0 auto",padding:"36px 24px"},
  h1:{fontSize:24,fontWeight:800,color:C.text,letterSpacing:"-0.03em",margin:0},
  h2:{fontSize:18,fontWeight:700,color:C.text,letterSpacing:"-0.02em",margin:0},
  h3:{fontSize:13,fontWeight:700,color:C.textLow,textTransform:"uppercase",letterSpacing:"0.07em",margin:0},
  sub:{fontSize:13,color:C.textMid},
  btnPrimary:{background:C.accent,color:"#fff",border:"none",borderRadius:8,padding:"9px 18px",cursor:"pointer",fontWeight:600,fontSize:13,fontFamily:"inherit"},
  btnSec:{background:"transparent",color:C.textMid,border:`1px solid ${C.border}`,borderRadius:8,padding:"8px 16px",cursor:"pointer",fontWeight:500,fontSize:13,fontFamily:"inherit"},
  btnDanger:{background:"transparent",color:C.red,border:"1px solid #7f1d1d",borderRadius:8,padding:"8px 16px",cursor:"pointer",fontWeight:500,fontSize:13,fontFamily:"inherit"},
  btnGhost:{background:"transparent",color:C.textLow,border:"none",cursor:"pointer",fontSize:13,padding:0,fontFamily:"inherit"},
  btnSmall:{background:C.accent,color:"#fff",border:"none",borderRadius:6,padding:"6px 12px",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit"},
  card:{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:"18px 20px",marginBottom:10,cursor:"pointer",transition:"border-color 0.15s,background 0.15s"},
  cardHov:{background:C.surfaceHi,border:`1px solid ${C.borderHi}`},
  form:{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:28},
  formGrid:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"16px 24px"},
  fg:{display:"flex",flexDirection:"column",gap:6},
  fgFull:{display:"flex",flexDirection:"column",gap:6,gridColumn:"1 / -1"},
  lbl:{fontSize:11,fontWeight:700,color:C.textMid,textTransform:"uppercase",letterSpacing:"0.06em"},
  input:{background:C.bg,border:`1px solid ${C.border}`,borderRadius:7,color:C.text,padding:"9px 11px",fontSize:13,outline:"none",width:"100%",boxSizing:"border-box",fontFamily:"inherit"},
  select:{background:C.bg,border:`1px solid ${C.border}`,borderRadius:7,color:C.text,padding:"9px 11px",fontSize:13,outline:"none",width:"100%",boxSizing:"border-box",cursor:"pointer",fontFamily:"inherit"},
  textarea:{background:C.bg,border:`1px solid ${C.border}`,borderRadius:7,color:C.text,padding:"9px 11px",fontSize:13,outline:"none",width:"100%",boxSizing:"border-box",resize:"vertical",minHeight:80,fontFamily:"inherit"},
  formFoot:{display:"flex",gap:10,justifyContent:"flex-end",marginTop:28,borderTop:`1px solid ${C.border}`,paddingTop:20},
  pill:{display:"inline-block",background:"#1a2236",border:`1px solid ${C.border}`,color:C.textMid,borderRadius:4,padding:"2px 8px",fontSize:12,margin:"2px 2px 2px 0"},
  pillRed:{borderColor:"#7f1d1d",color:C.red},
  backBtn:{background:"transparent",color:C.textMid,border:"none",cursor:"pointer",fontSize:13,padding:"0 0 22px 0",display:"flex",alignItems:"center",gap:6,fontFamily:"inherit"},
  notesBox:{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 14px",fontSize:13,color:C.textMid,lineHeight:1.65,whiteSpace:"pre-wrap"},
  statsRow:{display:"flex",gap:12,marginBottom:28,flexWrap:"wrap"},
  statCard:{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"16px 20px",flex:1,minWidth:110},
  statVal:{fontSize:22,fontWeight:800,color:C.text,letterSpacing:"-0.03em"},
  statLbl:{fontSize:11,color:C.textLow,marginTop:3,textTransform:"uppercase",letterSpacing:"0.06em"},
  tbl:{width:"100%",borderCollapse:"collapse",fontSize:13},
  th:{textAlign:"left",padding:"7px 12px",fontSize:11,fontWeight:700,color:C.textLow,textTransform:"uppercase",letterSpacing:"0.05em",borderBottom:`1px solid ${C.border}`},
  td:{padding:"11px 12px",borderBottom:"1px solid #151a24",color:C.textMid,verticalAlign:"middle"},
  tdBold:{padding:"11px 12px",borderBottom:"1px solid #151a24",color:C.text,fontWeight:600,verticalAlign:"middle"},
  sectionTitle:{fontSize:11,fontWeight:700,color:C.textLow,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:14,marginTop:28,borderBottom:`1px solid ${C.border}`,paddingBottom:8},
  aiBox:{background:"#0d1a2e",border:`1px solid #1e3a5f`,borderRadius:12,padding:"20px 22px",marginTop:12},
  aiTitle:{fontSize:13,fontWeight:700,color:C.accent,marginBottom:14,display:"flex",alignItems:"center",gap:8},
};

// ─────────────────────────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────────────────────────
function useToast() {
  const [toasts,setToasts] = useState([]);
  const add = useCallback((msg,type="success") => {
    const id = Date.now();
    setToasts(p=>[...p,{id,msg,type}]);
    setTimeout(()=>setToasts(p=>p.filter(t=>t.id!==id)),2800);
  },[]);
  return {toasts,add};
}
function ToastContainer({toasts}) {
  return (
    <div style={{position:"fixed",bottom:24,right:24,zIndex:9999,display:"flex",flexDirection:"column",gap:8,pointerEvents:"none"}}>
      {toasts.map(t=>(
        <div key={t.id} style={{background:t.type==="error"?"#2a0a0a":"#0d2a1a",border:`1px solid ${t.type==="error"?"#7f1d1d":"#166534"}`,color:t.type==="error"?C.red:C.green,borderRadius:10,padding:"11px 18px",fontSize:13,fontWeight:600,boxShadow:"0 4px 24px #00000066",minWidth:200,animation:"fadeInUp 0.2s ease"}}>
          {t.type==="error"?"✕ ":"✓ "}{t.msg}
        </div>
      ))}
      <style>{`@keyframes fadeInUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SMALL COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function GoalBadge({value}) {
  const label=GOAL_OPTIONS.find(g=>g.value===value)?.label??value;
  const colors=GOAL_COLORS[value]??{bg:"#1f2937",text:C.textMid,border:C.border};
  return <span style={{background:colors.bg,color:colors.text,border:`1px solid ${colors.border}`,borderRadius:5,padding:"2px 9px",fontSize:11,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase"}}>{label}</span>;
}
function SectionTitle({children,action}) {
  return <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",...T.sectionTitle}}><span>{children}</span>{action}</div>;
}
function StatCard({value,label}) {
  return <div style={T.statCard}><div style={T.statVal}>{value}</div><div style={T.statLbl}>{label}</div></div>;
}
function Badge({color,children}) {
  return <span style={{background:color+"22",color,border:`1px solid ${color}55`,borderRadius:5,padding:"2px 8px",fontSize:11,fontWeight:700}}>{children}</span>;
}
function Spinner() {
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",padding:"80px 0",flexDirection:"column",gap:16}}>
      <div style={{width:32,height:32,border:`3px solid ${C.border}`,borderTop:`3px solid ${C.accent}`,borderRadius:"50%",animation:"spin 0.8s linear infinite"}} />
      <div style={{color:C.textLow,fontSize:13}}>Laden…</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// APP ROOT
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [clients,        setClients]        = useState([]);
  const [equipment,      setEquipment]      = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [trainerId,      setTrainerId]      = useState(() => localStorage.getItem("pt_trainer_id") || null);
  const [view,           setView]           = useState("dashboard");
  const [clientId,       setClientId]       = useState(null);
  const [trainingId,     setTrainingId]     = useState(null);
  const [groupClientIds, setGroupClientIds] = useState([]);
  const [hovered,        setHovered]        = useState(null);
  const [search,         setSearch]         = useState("");
  const {toasts,add:toast} = useToast();

  // Initial load - herlaadt bij trainer wissel
  useEffect(() => {
    if (!trainerId) { setClients([]); return; }
    (async () => {
      try {
        setLoading(true);
        setClients([]); // reset bij trainer wissel
        const [clientRows, eqRows] = await Promise.all([db.getClients(trainerId), db.getEquipment()]);
        const clientsWithData = await Promise.all(
          (clientRows ?? []).map(async (row) => {
            const [tRows, iRows] = await Promise.all([db.getTrainings(row.id), db.getInbody(row.id)]);
            return rowToClient(row, (tRows ?? []).map(rowToTraining), (iRows ?? []).map(rowToInbody));
          })
        );
        setClients(clientsWithData);
        if ((eqRows ?? []).length === 0) {
          for (const eq of DEFAULT_EQUIPMENT) await db.upsertEquipment(eq);
          setEquipment(DEFAULT_EQUIPMENT);
        } else {
          setEquipment(eqRows.map(r => ({ id: r.id, name: r.name, exercises: r.exercises ?? [] })));
        }
      } catch(e) {
        console.error(e);
        toast("Verbinding mislukt", "error");
      } finally {
        setLoading(false);
      }
    })();
  }, [trainerId]); // <-- trainerId als dependency: herlaadt bij wisselen

  const client   = clients.find(c=>c.id===clientId)??null;
  const training = client?.trainings?.find(t=>t.id===trainingId)??null;

  const go = (v,cId,tId) => { setView(v); if(cId!==undefined) setClientId(cId); if(tId!==undefined) setTrainingId(tId); window.scrollTo(0,0); };

  // Client CRUD
  const saveClient = async (data) => {
    try {
      const isNew = !clients.find(c=>c.id===data.id);
      const clientTrainer = data.trainerId || trainerId || "teun";
      const clientData = isNew ? {...blankClient(),...data,id:uid(),createdAt:new Date().toISOString(),trainerId:clientTrainer} : {...data,trainerId:clientTrainer};
      if (isNew) { await db.insertClient(clientData); } else { await db.updateClient(clientData); }
      if (isNew) {
        // Alleen aan lokale lijst toevoegen als klant bij huidige trainer hoort
        if (clientTrainer === trainerId) {
          setClients(p=>[{...clientData,trainings:[],inbody:[]},...p]);
          setClientId(clientData.id);
          go("profile", clientData.id);
        } else {
          // Klant aangemaakt voor andere trainer - terug naar dashboard
          go("dashboard");
        }
        toast("Klant aangemaakt");
      } else {
        setClients(p=>p.map(c=>c.id===clientData.id?{...c,...clientData}:c));
        toast("Klant opgeslagen");
        go("profile", clientData.id);
      }
    } catch(e) { toast("Opslaan mislukt","error"); }
  };
  const deleteClient = async (id) => {
    if(!window.confirm("Klant definitief verwijderen?")) return;
    try {
      await db.deleteClient(id);
      setClients(p=>p.filter(c=>c.id!==id));
      toast("Klant verwijderd"); go("dashboard");
    } catch(e) { toast("Verwijderen mislukt","error"); }
  };

  // Training CRUD
  const saveTraining = async (t) => {
    try {
      const tExists = clients.find(c=>c.id===clientId)?.trainings?.find(x=>x.id===t.id); if (tExists) { await db.updateTraining(t); } else { await db.insertTraining(t, clientId); }
      setClients(p=>p.map(c=>{
        if(c.id!==clientId) return c;
        const exists = c.trainings?.find(x=>x.id===t.id);
        const trainings = exists ? c.trainings.map(x=>x.id===t.id?t:x) : [t,...(c.trainings??[])];
        return {...c,trainings};
      }));
      toast("Training opgeslagen"); go("profile",clientId);
    } catch(e) { toast("Opslaan mislukt","error"); }
  };
  const deleteTraining = async (tId) => {
    if(!window.confirm("Training verwijderen?")) return;
    try {
      await db.deleteTraining(tId);
      setClients(p=>p.map(c=>c.id!==clientId?c:{...c,trainings:c.trainings.filter(t=>t.id!==tId)}));
      toast("Training verwijderd"); go("profile",clientId);
    } catch(e) { toast("Verwijderen mislukt","error"); }
  };

  // Groepstraining
  const saveGroupTrainings = async (trainingsMap) => {
    try {
      await Promise.all(Object.entries(trainingsMap).map(([cId,t]) => db.insertTraining(t,cId)));
      setClients(p=>p.map(c=>{
        const t = trainingsMap[c.id]; if(!t) return c;
        return {...c, trainings:[t,...(c.trainings??[])]};
      }));
      toast(`${Object.keys(trainingsMap).length} trainingen opgeslagen`); go("dashboard");
    } catch(e) { toast("Opslaan mislukt","error"); }
  };

  // AI analyses
  const saveAnalysis = async (cId, analysis) => {
    const c = clients.find(x=>x.id===cId); if(!c) return;
    const updated = [analysis,...(c.aiAnalyses??[])].slice(0,3);
    try {
      await db.updateClient({...c, aiAnalyses: updated});
      setClients(p=>p.map(x=>x.id===cId?{...x,aiAnalyses:updated}:x));
    } catch(e) {}
  };

  // InBody metingen
  const saveInbody = async (m) => {
    try {
      await db.insertInbody(m, clientId);
      setClients(p=>p.map(c=>c.id!==clientId?c:{...c,inbody:[m,...(c.inbody??[])]}));
      toast("InBody-meting opgeslagen");
      go("inbody", clientId);
    } catch(e) { toast("Opslaan mislukt","error"); }
  };
  const deleteInbody = async (mId) => {
    if(!window.confirm("Meting verwijderen?")) return;
    try {
      await db.deleteInbody(mId);
      setClients(p=>p.map(c=>c.id!==clientId?c:{...c,inbody:(c.inbody??[]).filter(m=>m.id!==mId)}));
      toast("Meting verwijderd");
    } catch(e) { toast("Verwijderen mislukt","error"); }
  };

  // Equipment
  const updateEquipment = async (newEq) => {
    try {
      setEquipment(newEq);
      await db.replaceAllEquipment(newEq);
    } catch(e) { toast("Apparatuur opslaan mislukt","error"); }
  };

  const filtered = clients.filter(c=>c.name.toLowerCase().includes(search.toLowerCase()));

  const selectTrainer = (id) => {
    localStorage.setItem("pt_trainer_id", id);
    setTrainerId(id);
    setView("dashboard");
    setClientId(null);
    setTrainingId(null);
  };

  if (!trainerId) return (
    <div style={{...T.app,display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh"}}>
      <div style={{textAlign:"center",padding:40}}>
        <div style={{fontSize:40,marginBottom:16}}>▲</div>
        <div style={{fontWeight:800,fontSize:22,color:C.text,marginBottom:8,letterSpacing:"-0.03em"}}>
          PT <span style={{color:C.accent}}>Progress</span> Tracker
        </div>
        <div style={{fontSize:14,color:C.textMid,marginBottom:36}}>Wie ben jij?</div>
        <div style={{display:"flex",gap:16,justifyContent:"center",flexWrap:"wrap"}}>
          {[{id:"teun",name:"Teun",emoji:"💪"},{id:"thijs",name:"Thijs",emoji:"🏋️"}].map(t=>(
            <button key={t.id} style={{...T.btnPrimary,fontSize:16,padding:"16px 36px",borderRadius:12,display:"flex",flexDirection:"column",alignItems:"center",gap:8,background:C.surface,border:`2px solid ${C.border}`,color:C.text,cursor:"pointer"}}
              onClick={()=>selectTrainer(t.id)}
              onMouseEnter={e=>{e.currentTarget.style.borderColor=C.accent;e.currentTarget.style.background=C.accentDim;}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.background=C.surface;}}>
              <span style={{fontSize:32}}>{t.emoji}</span>
              <span style={{fontWeight:700,fontSize:16}}>{t.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  if (loading) return (
    <div style={T.app}>
      <header style={T.header}>
        <div style={{fontWeight:800,fontSize:16,color:C.text,letterSpacing:"-0.03em",display:"flex",alignItems:"center",gap:8}}>
          <span style={{color:C.accent,fontSize:20}}>▲</span>PT<span style={{color:C.accent}}> Progress</span> Tracker
        </div>
      </header>
      <main style={T.main}><Spinner /></main>
    </div>
  );

  return (
    <div style={T.app}>
      <header style={T.header}>
        <div style={{fontWeight:800,fontSize:16,color:C.text,letterSpacing:"-0.03em",display:"flex",alignItems:"center",gap:8,cursor:"pointer"}} onClick={()=>go("dashboard")}>
          <span style={{color:C.accent,fontSize:20}}>▲</span>PT<span style={{color:C.accent}}> Progress</span> Tracker
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {client&&view!=="dashboard"&&<span style={{fontSize:12,color:C.textLow,marginRight:4}}>{client.name}</span>}
          <button style={{background:"transparent",color:view==="dashboard"?C.accent:C.textMid,border:"none",cursor:"pointer",fontSize:13,fontWeight:view==="dashboard"?700:500,fontFamily:"inherit"}} onClick={()=>go("dashboard")}>Dashboard</button>
          <button style={{background:"transparent",color:view==="settings"?C.accent:C.textMid,border:"none",cursor:"pointer",fontSize:13,fontWeight:view==="settings"?700:500,fontFamily:"inherit"}} onClick={()=>go("settings")}>⚙</button>
          <button style={{background:C.accentDim,color:C.accent,border:`1px solid ${C.accentDim}`,borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:"inherit",padding:"4px 10px"}}
            onClick={()=>{localStorage.removeItem("pt_trainer_id");setTrainerId(null);setClients([]);setView("dashboard");setClientId(null);}}>
            {trainerId==="teun"?"💪 Teun":"🏋️ Thijs"} ↓
          </button>
        </div>
      </header>
      <main style={T.main}>
        {view==="dashboard"       && <Dashboard clients={filtered} search={search} setSearch={setSearch} hovered={hovered} setHovered={setHovered} onNew={()=>go("client-form")} onOpen={c=>go("profile",c.id)} onGroupTraining={(ids)=>{setGroupClientIds(ids);go("group-training");}} />}
        {view==="client-form"     && <ClientForm initial={client} onSave={saveClient} onCancel={()=>go(clientId?"profile":"dashboard")} />}
        {view==="profile"         && client && <ClientProfile client={client} hovered={hovered} setHovered={setHovered} onEdit={()=>go("client-form",clientId)} onDelete={()=>deleteClient(clientId)} onNewTraining={()=>{setTrainingId(null);go("training-form",clientId,null);}} onOpenTraining={t=>go("training-detail",clientId,t.id)} onProgressie={()=>go("progressie",clientId)} onAI={()=>go("ai",clientId)} onInbody={()=>go("inbody",clientId)} />}
        {view==="training-form"   && client && <TrainingForm client={client} training={training} equipment={equipment} onSave={saveTraining} onCancel={()=>go("profile",clientId)} toast={toast} />}
        {view==="training-detail" && client&&training && <TrainingDetail training={training} client={client} onBack={()=>go("profile",clientId)} onEdit={()=>go("training-form",clientId,trainingId)} onDelete={()=>deleteTraining(trainingId)} />}
        {view==="progressie"      && client && <Progressie client={client} onBack={()=>go("profile",clientId)} />}
        {view==="ai"              && client && <AIAnalyse client={client} equipment={equipment} onBack={()=>go("profile",clientId)} onSaveAnalysis={saveAnalysis} toast={toast} />}
        {view==="inbody"          && client && <InbodyOverview client={client} onBack={()=>go("profile",clientId)} onNew={()=>go("inbody-add",clientId)} onDelete={deleteInbody} />}
        {view==="inbody-add"      && client && <InbodyAdd client={client} onSave={saveInbody} onCancel={()=>go("inbody",clientId)} toast={toast} />}
        {view==="settings"        && <Settings equipment={equipment} setEquipment={updateEquipment} toast={toast} onBack={()=>go("dashboard")} />}
        {view==="group-training"  && <GroupTraining clients={clients.filter(c=>groupClientIds.includes(c.id))} equipment={equipment} onSave={saveGroupTrainings} onCancel={()=>go("dashboard")} toast={toast} />}
      </main>
      <ToastContainer toasts={toasts} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
function Dashboard({clients,search,setSearch,onNew,onOpen,hovered,setHovered,onGroupTraining}) {
  const [selectMode,setSelectMode] = useState(false);
  const [selectedIds,setSelectedIds] = useState([]);
  const toggleSelect = (id) => setSelectedIds(p=>p.includes(id)?p.filter(x=>x!==id):p.length<3?[...p,id]:p);
  return (
    <>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:28,gap:16,flexWrap:"wrap"}}>
        <div><h1 style={T.h1}>Klanten</h1><p style={{...T.sub,marginTop:4}}>{clients.length===0&&!search?"Voeg je eerste klant toe.":`${clients.length} klant${clients.length!==1?"en":""}`}</p></div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {!selectMode
            ? <button style={{...T.btnSec,borderColor:C.accentDim,color:C.accent}} onClick={()=>{setSelectMode(true);setSelectedIds([]); }}>👥 Groepstraining</button>
            : <><button style={{...T.btnSec,color:C.textLow}} onClick={()=>{setSelectMode(false);setSelectedIds([]);}}>Annuleren</button>
               <button style={{...T.btnPrimary,opacity:selectedIds.length<2?0.5:1}} onClick={()=>selectedIds.length>=2&&onGroupTraining(selectedIds)} disabled={selectedIds.length<2}>Start ({selectedIds.length}/3)</button></>
          }
          {!selectMode && <button style={T.btnPrimary} onClick={onNew}>+ Nieuwe klant</button>}
        </div>
      </div>
      {selectMode && <div style={{background:"#1a2236",border:`1px solid ${C.accentDim}`,borderRadius:10,padding:"11px 16px",fontSize:13,color:C.textMid,marginBottom:16}}>Selecteer 2 of 3 klanten voor een groepstraining.</div>}
      <input style={{...T.input,maxWidth:320,marginBottom:20}} placeholder="🔍  Zoek op naam..." value={search} onChange={e=>setSearch(e.target.value)} />
      {clients.length===0?(
        <div style={{textAlign:"center",padding:"64px 24px",color:C.textLow}}>
          <div style={{fontSize:44,marginBottom:14}}>🏋️</div>
          <div style={{fontSize:15,fontWeight:600,color:C.textMid,marginBottom:8}}>{search?"Geen klanten gevonden":"Nog geen klanten"}</div>
          {!search&&<button style={T.btnPrimary} onClick={onNew}>+ Nieuwe klant toevoegen</button>}
        </div>
      ):clients.map(c=>{
        const last=c.trainings?.[0]; const selected=selectedIds.includes(c.id);
        return (
          <div key={c.id}
            style={selected?{...T.card,border:`1px solid ${C.accent}`,background:"#0d1a2e"}:hovered===c.id?{...T.card,background:C.surfaceHi,border:`1px solid ${C.borderHi}`}:T.card}
            onClick={()=>selectMode?toggleSelect(c.id):onOpen(c)}
            onMouseEnter={()=>setHovered(c.id)} onMouseLeave={()=>setHovered(null)}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:8}}>
              <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                {selectMode&&<div style={{width:20,height:20,borderRadius:5,border:`2px solid ${selected?C.accent:C.border}`,background:selected?C.accent:"transparent",flexShrink:0,marginTop:2,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#fff"}}>{selected&&"✓"}</div>}
                <div>
                  <div style={{fontSize:15,fontWeight:700,color:C.text,marginBottom:7}}>{c.name}</div>
                  <div style={{display:"flex",gap:14,flexWrap:"wrap",alignItems:"center",fontSize:12,color:C.textLow}}>
                    <GoalBadge value={c.goal} />
                    {c.frequency&&<span>📅 {c.frequency}× /week</span>}
                    <span>🏋️ {c.trainings?.length??0} training{(c.trainings?.length??0)!==1?"en":""}</span>
                    {c.currentFocus&&<span>🎯 {c.currentFocus}</span>}
                  </div>
                </div>
              </div>
              {last&&<span style={{fontSize:12,color:C.textLow}}>{fmtDate(last.date)}</span>}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT FORM
// ─────────────────────────────────────────────────────────────────────────────
function ClientForm({initial,onSave,onCancel}) {
  const currentTrainer = localStorage.getItem("pt_trainer_id") || "teun";
  const [form,setForm] = useState(initial??{name:"",goal:"algemeen",frequency:"",injuries:"",preferredExercises:"",dislikedExercises:"",currentFocus:"",notes:"",trainerId:currentTrainer});
  const set=(k,v)=>setForm(p=>({...p,[k]:v}));
  return (
    <>
      <button style={T.backBtn} onClick={onCancel}>← Terug</button>
      <div style={T.form}>
        <h2 style={{...T.h2,marginBottom:24}}>{initial?.id?"Klant bewerken":"Nieuwe klant"}</h2>
        <div style={T.formGrid}>
          <div style={T.fg}><label style={T.lbl}>Naam *</label><input style={T.input} value={form.name} placeholder="Volledige naam" onChange={e=>set("name",e.target.value)} /></div>
          <div style={T.fg}><label style={T.lbl}>Doel</label><select style={T.select} value={form.goal} onChange={e=>set("goal",e.target.value)}>{GOAL_OPTIONS.map(g=><option key={g.value} value={g.value}>{g.label}</option>)}</select></div>
          <div style={T.fgFull}>
            <label style={T.lbl}>Trainer</label>
            <div style={{display:"flex",gap:10}}>
              {[{id:"teun",label:"💪 Teun"},{id:"thijs",label:"🏋️ Thijs"}].map(t=>(
                <button key={t.id} type="button"
                  style={{flex:1,padding:"10px",borderRadius:8,border:`2px solid ${form.trainerId===t.id?C.accent:C.border}`,background:form.trainerId===t.id?C.accentDim:"transparent",color:form.trainerId===t.id?C.accent:C.textMid,cursor:"pointer",fontWeight:form.trainerId===t.id?700:500,fontSize:14,fontFamily:"inherit"}}
                  onClick={()=>set("trainerId",t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div style={T.fg}><label style={T.lbl}>Trainingsfrequentie (per week)</label><input style={T.input} value={form.frequency} placeholder="bijv. 3" onChange={e=>set("frequency",e.target.value)} /></div>
          <div style={T.fg}><label style={T.lbl}>Huidige focus</label><input style={T.input} value={form.currentFocus} placeholder="bijv. squat techniek" onChange={e=>set("currentFocus",e.target.value)} /></div>
          <div style={T.fgFull}><label style={T.lbl}>Blessures of klachten</label><input style={T.input} value={form.injuries} placeholder="bijv. knieklachten links" onChange={e=>set("injuries",e.target.value)} /></div>
          <div style={T.fgFull}><label style={T.lbl}>Voorkeursoefeningen</label><input style={T.input} value={form.preferredExercises} placeholder="bijv. deadlift, pull-ups" onChange={e=>set("preferredExercises",e.target.value)} /></div>
          <div style={T.fgFull}><label style={T.lbl}>Oefeningen die klant niet fijn vindt</label><input style={T.input} value={form.dislikedExercises} placeholder="bijv. leg press" onChange={e=>set("dislikedExercises",e.target.value)} /></div>
          <div style={T.fgFull}><label style={T.lbl}>Coach-notities</label><textarea style={T.textarea} value={form.notes} placeholder="Vrije notities..." onChange={e=>set("notes",e.target.value)} /></div>
        </div>
        <div style={T.formFoot}>
          <button style={T.btnSec} onClick={onCancel}>Annuleren</button>
          <button style={T.btnPrimary} onClick={()=>{if(!form.name.trim()){alert("Vul een naam in.");return;}onSave({...initial,...form});}}>Opslaan</button>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT PROFILE
// ─────────────────────────────────────────────────────────────────────────────
function ClientProfile({client,onEdit,onDelete,onNewTraining,onOpenTraining,onProgressie,onAI,onInbody,hovered,setHovered}) {
  const trainings=client.trainings??[];
  const [periodFilter,setPeriodFilter]=useState("all");
  const filterT=(ts)=>{if(periodFilter==="all")return ts;const days=periodFilter==="30"?30:periodFilter==="90"?90:180;const cutoff=new Date(Date.now()-days*86400000);return ts.filter(t=>new Date(t.date+"T12:00:00")>=cutoff);};
  const visible=filterT(trainings);
  const complaints=trainings.filter(t=>t.complaints?.trim()).map(t=>({date:t.date,text:t.complaints}));
  return (
    <>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:24,flexWrap:"wrap",gap:12}}>
        <div><h1 style={{...T.h1,marginBottom:8}}>{client.name}</h1><GoalBadge value={client.goal} /></div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button style={T.btnSec} onClick={onEdit}>Bewerken</button>
          <button style={T.btnDanger} onClick={onDelete}>Verwijderen</button>
        </div>
      </div>
      <div style={{display:"flex",gap:10,marginBottom:28,flexWrap:"wrap"}}>
        <button style={T.btnPrimary} onClick={onNewTraining}>+ Training toevoegen</button>
        <button style={T.btnSec} onClick={onProgressie}>📈 Progressie</button>
        <button style={{...T.btnSec,borderColor:C.accentDim,color:C.accent}} onClick={onAI}>✦ AI-analyse</button>
        <button style={T.btnSec} onClick={onInbody}>⚖️ InBody</button>
      </div>
      <div style={T.statsRow}>
        <StatCard value={trainings.length} label="Trainingen" />
        <StatCard value={client.frequency?`${client.frequency}×`:"—"} label="Per week" />
        <StatCard value={trainings.length>0?fmtShort(trainings[0].date):"—"} label="Laatste training" />
        <StatCard value={client.currentFocus||"—"} label="Huidige focus" />
      </div>
      <SectionTitle>Klantinfo</SectionTitle>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"14px 28px",marginBottom:8}}>
        {[["Blessures / klachten",client.injuries],["Klant sinds",fmtDate(client.createdAt)]].map(([lbl,val])=>(
          <div key={lbl}><div style={{fontSize:11,fontWeight:600,color:C.textLow,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>{lbl}</div><div style={{fontSize:13,color:C.textMid}}>{val||"—"}</div></div>
        ))}
        <div><div style={{fontSize:11,fontWeight:600,color:C.textLow,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>Voorkeursoefeningen</div><div>{client.preferredExercises?client.preferredExercises.split(",").map((e,i)=><span key={i} style={T.pill}>{e.trim()}</span>):<span style={{fontSize:13,color:C.textMid}}>—</span>}</div></div>
        <div><div style={{fontSize:11,fontWeight:600,color:C.textLow,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>Niet-fijne oefeningen</div><div>{client.dislikedExercises?client.dislikedExercises.split(",").map((e,i)=><span key={i} style={{...T.pill,...T.pillRed}}>{e.trim()}</span>):<span style={{fontSize:13,color:C.textMid}}>—</span>}</div></div>
      </div>
      {client.notes&&<><SectionTitle>Coach-notities</SectionTitle><div style={T.notesBox}>{client.notes}</div></>}
      <SectionTitle action={
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <select style={{...T.select,padding:"4px 8px",fontSize:12,width:"auto"}} value={periodFilter} onChange={e=>setPeriodFilter(e.target.value)}>
            <option value="all">Alle</option><option value="30">Laatste 30 dagen</option><option value="90">Laatste 3 maanden</option><option value="180">Laatste 6 maanden</option>
          </select>
          <button style={T.btnSmall} onClick={onNewTraining}>+ Training</button>
        </div>
      }>Trainingen</SectionTitle>
      {visible.length===0?(
        <div style={{padding:"20px 0",color:C.textLow,fontSize:13}}>{trainings.length===0?"Nog geen trainingen. Klik op \"+ Training toevoegen\" om te starten.":"Geen trainingen in deze periode."}</div>
      ):visible.map(t=>{
        const exCount=t.exercises?.length??0;const energy=t.energy?ENERGY_LABELS[t.energy]:null;
        return (
          <div key={t.id} style={hovered===t.id?{...T.card,background:C.surfaceHi,border:`1px solid ${C.borderHi}`}:T.card} onClick={()=>onOpenTraining(t)} onMouseEnter={()=>setHovered(t.id)} onMouseLeave={()=>setHovered(null)}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
              <div>
                <div style={{fontSize:14,fontWeight:700,color:C.text,marginBottom:6}}>{fmtDate(t.date)}</div>
                <div style={{display:"flex",gap:12,flexWrap:"wrap",fontSize:12,color:C.textLow,alignItems:"center"}}>
                  <span>🏋️ {exCount} oefening{exCount!==1?"en":""}</span>
                  {energy&&<span>{energy}</span>}
                  {t.nextFocus&&<span style={{color:C.accent}}>📌 {t.nextFocus}</span>}
                  {t.complaints&&<span style={{color:C.red}}>⚠️ {t.complaints}</span>}
                </div>
              </div>
              <span style={{color:C.textLow,fontSize:18}}>›</span>
            </div>
          </div>
        );
      })}
      {complaints.length>0&&(
        <><SectionTitle>Aandachtspunten</SectionTitle>
        <div style={{background:"#1a0f0f",border:"1px solid #7f1d1d",borderRadius:10,overflow:"hidden"}}>
          {complaints.map((c,i)=>(
            <div key={i} style={{display:"flex",gap:16,padding:"12px 16px",borderBottom:i<complaints.length-1?"1px solid #2a1515":"none",alignItems:"flex-start"}}>
              <span style={{fontSize:12,color:C.textLow,whiteSpace:"nowrap",minWidth:80,paddingTop:1}}>{fmtShort(c.date)}</span>
              <span style={{fontSize:13,color:"#fca5a5"}}>⚠️ {c.text}</span>
            </div>
          ))}
        </div></>
      )}
    </>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// EXERCISE BLOCK (sets apart invullen)
// ─────────────────────────────────────────────────────────────────────────────
const RPE_LABELS = {
  1:"Heel licht",2:"Licht",3:"Matig",4:"Redelijk",5:"Gemiddeld",
  6:"Zwaar",7:"Zwaar (3 reps over)",8:"Zwaar (2 reps over)",
  9:"Zeer zwaar (1 rep over)",10:"Maximaal"
};

function ExerciseBlock({ex,idx,canRemove,onRemove,onChange,onSetChange,onAddSet,onRemoveSet}) {
  const [showRpeInfo,setShowRpeInfo] = useState(false);
  const useSets = ex.setData && ex.setData.length > 0;

  const copyToAll = () => {
    if(!ex.setData?.length) return;
    const first = ex.setData[0];
    ex.setData.forEach(s => {
      if(s.id !== first.id) {
        onSetChange(s.id,"reps",first.reps);
        onSetChange(s.id,"weight",first.weight);
        onSetChange(s.id,"rpe",first.rpe);
      }
    });
  };

  return (
    <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"16px 18px",marginBottom:10}}>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <span style={{fontSize:12,fontWeight:700,color:ex.name?C.textMid:C.textLow}}>{ex.name||`Oefening ${idx+1}`}</span>
        {canRemove&&<button style={{...T.btnGhost,color:C.red,fontSize:12}} onClick={onRemove}>✕</button>}
      </div>

      {/* Naam + techniek */}
      <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:"10px 14px",marginBottom:14}}>
        <div style={T.fg}>
          <label style={T.lbl}>Oefening</label>
          <input style={T.input} value={ex.name} placeholder="Typ of kies hierboven" onChange={e=>onChange("name",e.target.value)} />
        </div>
        <div style={T.fg}>
          <label style={T.lbl}>Techniek (★)</label>
          <select style={T.select} value={ex.technique} onChange={e=>onChange("technique",e.target.value)}>
            <option value="">—</option>
            <option value="1">1★ – Moet verbeteren</option>
            <option value="2">2★★ – Ruimte</option>
            <option value="3">3★★★ – Acceptabel</option>
            <option value="4">4★★★★ – Goed</option>
            <option value="5">5★★★★★ – Uitstekend</option>
          </select>
        </div>
      </div>

      {/* Sets modus toggle */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <span style={{fontSize:11,fontWeight:700,color:C.textLow,textTransform:"uppercase",letterSpacing:"0.06em"}}>
          {useSets ? `${ex.setData.length} sets` : "Sets & gewicht"}
        </span>
        <div style={{display:"flex",gap:8}}>
          {useSets && ex.setData.length > 1 && (
            <button style={{...T.btnGhost,fontSize:11,color:C.accent}} onClick={copyToAll}>
              ⎘ Kopieer set 1 naar alle
            </button>
          )}
          <button style={{...T.btnGhost,fontSize:11,color:useSets?C.red:C.accent}}
            onClick={()=>{
              if(useSets){onChange("setData",[])}
              else{onAddSet();}
            }}>
            {useSets?"− Terug naar algemeen":"+ Per set invullen"}
          </button>
        </div>
      </div>

      {/* Per set invullen */}
      {useSets ? (
        <div>
          {/* RPE uitleg knop */}
          <div style={{marginBottom:8}}>
            <button style={{...T.btnGhost,fontSize:11,color:C.textLow}} onClick={()=>setShowRpeInfo(p=>!p)}>
              ❓ Wat is RPE?
            </button>
            {showRpeInfo&&(
              <div style={{background:"#1a2236",border:`1px solid ${C.accentDim}`,borderRadius:8,padding:"12px 14px",marginTop:8,fontSize:12,color:C.textMid,lineHeight:1.7}}>
                <strong style={{color:C.accent}}>RPE = Rate of Perceived Exertion</strong> — hoe zwaar voelde de set aan?<br/>
                <strong style={{color:C.text}}>RPE 6</strong> — nog 4+ reps over &nbsp;
                <strong style={{color:C.text}}>RPE 7</strong> — nog 3 reps &nbsp;
                <strong style={{color:C.text}}>RPE 8</strong> — nog 2 reps &nbsp;
                <strong style={{color:C.text}}>RPE 9</strong> — nog 1 rep &nbsp;
                <strong style={{color:C.red}}>RPE 10</strong> — absoluut maximum
              </div>
            )}
          </div>

          {/* Set rows */}
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
              <thead>
                <tr>
                  <th style={{...T.th,width:40}}>Set</th>
                  <th style={T.th}>Reps</th>
                  <th style={T.th}>Gewicht (kg)</th>
                  <th style={T.th}>RPE</th>
                  <th style={{...T.th,width:32}}></th>
                </tr>
              </thead>
              <tbody>
                {ex.setData.map((s,i)=>(
                  <tr key={s.id}>
                    <td style={{...T.td,color:C.textLow,fontWeight:700,textAlign:"center"}}>#{i+1}</td>
                    <td style={T.td}>
                      <input style={{...T.input,padding:"6px 8px"}} type="number" min="0" value={s.reps} placeholder="8"
                        onChange={e=>onSetChange(s.id,"reps",e.target.value)} />
                    </td>
                    <td style={T.td}>
                      <input style={{...T.input,padding:"6px 8px"}} type="number" min="0" step="0.5" value={s.weight} placeholder="80"
                        onChange={e=>onSetChange(s.id,"weight",e.target.value)} />
                    </td>
                    <td style={T.td}>
                      <select style={{...T.select,padding:"6px 8px",color:s.rpe?rpeColor(s.rpe):C.textMid,fontWeight:s.rpe?700:400}} value={s.rpe} onChange={e=>onSetChange(s.id,"rpe",e.target.value)}>
                        <option value="">—</option>
                        {[1,2,3,4,5,6,7,8,9,10].map(n=><option key={n} value={n} style={{color:C.text,fontWeight:400}}>{n}</option>)}
                      </select>
                    </td>
                    <td style={T.td}>
                      {ex.setData.length>1&&(
                        <button style={{...T.btnGhost,color:C.red,fontSize:12}} onClick={()=>onRemoveSet(s.id)}>✕</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button style={{...T.btnSec,marginTop:8,fontSize:12,padding:"6px 12px"}} onClick={onAddSet}>
            + Set toevoegen
          </button>
        </div>
      ) : (
        /* Algemeen invullen */
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(110px,1fr))",gap:"10px 14px"}}>
          {[["sets","Sets","4"],["reps","Reps","8"],["weight","Gewicht (kg)","80"]].map(([k,l,ph])=>(
            <div key={k} style={T.fg}>
              <label style={T.lbl}>{l}</label>
              <input style={T.input} type="number" min="0" step={k==="weight"?"0.5":"1"} value={ex[k]} placeholder={ph}
                onChange={e=>onChange(k,e.target.value)} />
            </div>
          ))}
          <div style={T.fg}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
              <label style={T.lbl}>RPE (1–10)</label>
            </div>
            <select style={T.select} value={ex.rpe} onChange={e=>onChange("rpe",e.target.value)}>
              <option value="">—</option>
              {[1,2,3,4,5,6,7,8,9,10].map(n=><option key={n} value={n}>{n} – {RPE_LABELS[n]}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Opmerking */}
      <div style={{...T.fg,marginTop:12}}>
        <label style={T.lbl}>Opmerking</label>
        <input style={T.input} value={ex.note} placeholder="bijv. knieën meer naar buiten"
          onChange={e=>onChange("note",e.target.value)} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAINING FORM
// ─────────────────────────────────────────────────────────────────────────────
function TrainingForm({client,training,equipment,onSave,onCancel,toast}) {
  const [form,setForm]=useState(()=>training?JSON.parse(JSON.stringify(training)):blankTraining());
  const [pickerOpen,setPickerOpen]=useState(false);
  const [aiSugs,setAiSugs]=useState(null);
  const [aiLoading,setAiLoading]=useState(false);
  const [muscleFilter,setMuscleFilter]=useState("Alle");
  const [eqFilter,setEqFilter]=useState("Alle");
  const setF=(k,v)=>setForm(p=>({...p,[k]:v}));
  const setEx=(id,k,v)=>setForm(p=>({...p,exercises:p.exercises.map(e=>e.id===id?{...e,[k]:v}:e)}));
  const addEx=()=>setForm(p=>({...p,exercises:[...p.exercises,blankExercise()]}));
  const removeEx=(id)=>setForm(p=>({...p,exercises:p.exercises.filter(e=>e.id!==id)}));
  const allExercises=equipment.flatMap(eq=>eq.exercises.map(ex=>({...ex,equipment:eq.name})));
  const filteredExercises=allExercises.filter(ex=>(muscleFilter==="Alle"||ex.muscles.includes(muscleFilter))&&(eqFilter==="Alle"||ex.equipment===eqFilter));
  const usedNames=new Set(form.exercises.map(e=>e.name.toLowerCase()).filter(Boolean));
  const pickExercise=(exName)=>{
    if(usedNames.has(exName.toLowerCase()))return;
    const emptyIdx=form.exercises.findIndex(e=>!e.name.trim());
    if(emptyIdx>=0){setForm(p=>({...p,exercises:p.exercises.map((e,i)=>i===emptyIdx?{...e,name:exName}:e)}));}
    else{setForm(p=>({...p,exercises:[...p.exercises,{...blankExercise(),name:exName}]}));}
  };
  const fetchAISuggestions=async()=>{
    setAiLoading(true);setAiSugs(null);
    const availableNames=allExercises.map(e=>e.name).join(", ");
    const recentUnique=[...new Set((client.trainings??[]).slice(0,5).flatMap(t=>(t.exercises??[]).map(e=>e.name)).filter(Boolean))].join(", ");
    const prompt=`Je bent een PT-coach assistent. Stel 5 oefeningen voor.\nKlant: ${client.name}\nDoel: ${GOAL_OPTIONS.find(g=>g.value===client.goal)?.label??client.goal}\nBlessures: ${client.injuries||"geen"}\nFocus: ${client.currentFocus||"geen"}\nNiet-fijn: ${client.dislikedExercises||"geen"}\nRecent gedaan: ${recentUnique||"onbekend"}\nBeschikbaar: ${availableNames}\nKies ALLEEN uit beschikbare oefeningen. JSON array (geen markdown):\n[{"name":"naam exact","reason":"1 zin waarom"},...]`;
    try{const text=await callClaude([{role:"user",content:prompt}],600);setAiSugs(JSON.parse(text.replace(/```json|```/g,"").trim()));}
    catch{toast("AI-suggesties mislukt","error");setAiSugs([]);}
    setAiLoading(false);
  };
  return (
    <>
      <button style={T.backBtn} onClick={onCancel}>← Terug naar {client.name}</button>
      <div style={T.form}>
        <h2 style={{...T.h2,marginBottom:24}}>{training?"Training bewerken":"Training toevoegen"}</h2>
        <div style={{...T.formGrid,marginBottom:24}}>
          <div style={T.fg}><label style={T.lbl}>Datum</label><input type="date" style={T.input} value={form.date} onChange={e=>setF("date",e.target.value)} /></div>
          <div style={T.fg}><label style={T.lbl}>Energie klant (1–5)</label><select style={T.select} value={form.energy} onChange={e=>setF("energy",e.target.value)}><option value="">— Kies —</option>{[1,2,3,4,5].map(n=><option key={n} value={n}>{n} – {ENERGY_LABELS[n]}</option>)}</select></div>
          <div style={T.fgFull}><label style={T.lbl}>Klachten of pijn</label><input style={T.input} value={form.complaints} placeholder="bijv. lichte pijn rechter schouder" onChange={e=>setF("complaints",e.target.value)} /></div>
          <div style={T.fgFull}><label style={T.lbl}>Algemene opmerking</label><textarea style={{...T.textarea,minHeight:60}} value={form.notes} placeholder="Hoe liep de training overall?" onChange={e=>setF("notes",e.target.value)} /></div>
          <div style={T.fgFull}><label style={T.lbl}>Focus voor de volgende training</label><input style={T.input} value={form.nextFocus} placeholder="bijv. meer focus op heupscharnieren" onChange={e=>setF("nextFocus",e.target.value)} /></div>
        </div>
        <div style={{borderTop:`1px solid ${C.border}`,paddingTop:22,marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
            <h3 style={T.h3}>Oefeningen</h3>
            <button style={{...T.btnSec,borderColor:C.accentDim,color:C.accent,fontSize:12,padding:"6px 12px"}} onClick={()=>{setPickerOpen(p=>!p);if(!pickerOpen&&!aiSugs&&!aiLoading)fetchAISuggestions();}}>{pickerOpen?"✕ Sluiten":"🗂 Oefeningen kiezen"}</button>
          </div>
          {pickerOpen&&(
            <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:12,padding:20,marginBottom:16}}>
              <div style={{marginBottom:20}}>
                <div style={{fontSize:12,fontWeight:700,color:C.accent,marginBottom:10,display:"flex",alignItems:"center",gap:8}}>✦ AI-suggesties voor {client.name}{aiLoading&&<span style={{color:C.textLow,fontWeight:400}}>laden…</span>}</div>
                {aiLoading&&<div style={{color:C.textLow,fontSize:13}}>Claude bedenkt de beste oefeningen…</div>}
                {aiSugs&&aiSugs.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:8}}>{aiSugs.map((s,i)=>{const already=usedNames.has(s.name.toLowerCase());return(<button key={i} title={s.reason} style={{background:already?"#1a2236":C.accentDim,color:already?C.textLow:C.accent,border:`1px solid ${already?C.border:C.accent+"55"}`,borderRadius:7,padding:"7px 12px",cursor:already?"default":"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",opacity:already?0.5:1}} onClick={()=>!already&&pickExercise(s.name)}>{already?"✓ ":""}{s.name}</button>);})}</div>}
                {aiSugs&&<button style={{...T.btnGhost,color:C.textLow,fontSize:12,marginTop:8}} onClick={fetchAISuggestions}>↺ Nieuwe suggesties</button>}
              </div>
              {/* Spiergroep tabs */}
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>
                {["Alle",...MUSCLE_GROUPS].map(m=>(
                  <button key={m}
                    style={{background:muscleFilter===m?C.accent:"transparent",color:muscleFilter===m?"#fff":C.textMid,border:`1px solid ${muscleFilter===m?C.accent:C.border}`,borderRadius:20,padding:"5px 12px",cursor:"pointer",fontSize:12,fontWeight:muscleFilter===m?700:400,fontFamily:"inherit",whiteSpace:"nowrap"}}
                    onClick={()=>setMuscleFilter(m)}>{m}
                  </button>
                ))}
              </div>
              {/* Per apparaat, gefilterd op spiergroep */}
              {equipment.filter(eq=>eq.exercises.some(ex=>muscleFilter==="Alle"||ex.muscles.includes(muscleFilter))).map(eq=>{
                const exs=eq.exercises.filter(ex=>muscleFilter==="Alle"||ex.muscles.includes(muscleFilter));
                if(!exs.length) return null;
                return (
                  <div key={eq.id} style={{marginBottom:14}}>
                    <div style={{fontSize:11,fontWeight:700,color:C.textLow,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8,paddingBottom:4,borderBottom:`1px solid ${C.border}`}}>{eq.name}</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                      {exs.map(ex=>{const already=usedNames.has(ex.name.toLowerCase());return(
                        <button key={ex.id}
                          style={{background:already?C.accentDim:"#1a2236",color:already?C.accent:C.textMid,border:`1px solid ${already?C.accent+"55":C.border}`,borderRadius:20,padding:"6px 14px",cursor:already?"default":"pointer",fontSize:12,fontWeight:already?700:500,fontFamily:"inherit",whiteSpace:"nowrap"}}
                          onClick={()=>!already&&pickExercise(ex.name)}>
                          {already&&"✓ "}{ex.name}
                        </button>
                      );})}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {form.exercises.map((ex,idx)=>(
            <ExerciseBlock key={ex.id} ex={ex} idx={idx} canRemove={form.exercises.length>1}
              onRemove={()=>removeEx(ex.id)}
              onChange={(k,v)=>setEx(ex.id,k,v)}
              onSetChange={(sid,k,v)=>setForm(p=>({...p,exercises:p.exercises.map(e=>e.id===ex.id?{...e,setData:e.setData.map(s=>s.id===sid?{...s,[k]:v}:s)}:e)}))}
              onAddSet={()=>setForm(p=>({...p,exercises:p.exercises.map(e=>e.id===ex.id?{...e,setData:[...(e.setData||[]),blankSet()]}:e)}))}
              onRemoveSet={(sid)=>setForm(p=>({...p,exercises:p.exercises.map(e=>e.id===ex.id?{...e,setData:(e.setData||[]).filter(s=>s.id!==sid)}:e)}))}
            />
          ))}
          <button style={{...T.btnSec,width:"100%",marginTop:4}} onClick={addEx}>+ Oefening toevoegen</button>
        </div>
        <div style={T.formFoot}><button style={T.btnSec} onClick={onCancel}>Annuleren</button><button style={T.btnPrimary} onClick={()=>onSave({...form})}>Training opslaan</button></div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAINING DETAIL
// ─────────────────────────────────────────────────────────────────────────────
function TrainingDetail({training,client,onBack,onEdit,onDelete}) {
  const energy=training.energy?ENERGY_LABELS[training.energy]:null;
  return (
    <>
      <button style={T.backBtn} onClick={onBack}>← Terug naar {client.name}</button>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:24,flexWrap:"wrap",gap:12}}>
        <div><h1 style={{...T.h1,marginBottom:10}}>{fmtDate(training.date)}</h1><div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{energy&&<Badge color={C.accent}>{energy}</Badge>}{training.complaints&&<Badge color={C.red}>⚠️ {training.complaints}</Badge>}</div></div>
        <div style={{display:"flex",gap:8}}><button style={T.btnSec} onClick={onEdit}>Bewerken</button><button style={T.btnDanger} onClick={onDelete}>Verwijderen</button></div>
      </div>
      <SectionTitle>Oefeningen</SectionTitle>
      <div style={{marginBottom:8}}>
        {(training.exercises??[]).map(ex=>(
          <div key={ex.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"14px 16px",marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:ex.setData?.length>0?12:0,flexWrap:"wrap",gap:8}}>
              <div>
                <span style={{fontSize:14,fontWeight:700,color:C.text}}>{ex.name||"—"}</span>
                {ex.technique&&<span style={{color:C.yellow,marginLeft:10,letterSpacing:1}}>{techStars(ex.technique)}</span>}
              </div>
              <div style={{display:"flex",gap:12,fontSize:12,color:C.textLow,flexWrap:"wrap"}}>
                {ex.note&&<span style={{color:C.textMid,fontStyle:"italic"}}>{ex.note}</span>}
              </div>
            </div>
            {ex.setData?.length>0?(
              <div style={{overflowX:"auto"}}>
                <table style={{...T.tbl,marginTop:4}}>
                  <thead><tr>{["Set","Reps","Gewicht","RPE"].map(h=><th key={h} style={{...T.th,padding:"5px 10px"}}>{h}</th>)}</tr></thead>
                  <tbody>{ex.setData.map((s,i)=>(
                    <tr key={s.id}>
                      <td style={{...T.td,padding:"8px 10px",color:C.textLow,fontWeight:600}}>#{i+1}</td>
                      <td style={{...T.td,padding:"8px 10px"}}>{s.reps||"—"}</td>
                      <td style={{...T.td,padding:"8px 10px"}}>{s.weight?`${s.weight} kg`:"—"}</td>
                      <td style={{...T.td,padding:"8px 10px"}}>{s.rpe?<span style={{color:rpeColor(s.rpe),fontWeight:700}}>{s.rpe}</span>:"—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ):(
              <div style={{display:"flex",gap:20,fontSize:13,color:C.textMid,flexWrap:"wrap",marginTop:4}}>
                {ex.sets&&<span><span style={{color:C.textLow,fontSize:11}}>SETS </span>{ex.sets}</span>}
                {ex.reps&&<span><span style={{color:C.textLow,fontSize:11}}>REPS </span>{ex.reps}</span>}
                {ex.weight&&<span><span style={{color:C.textLow,fontSize:11}}>KG </span>{ex.weight}</span>}
                {ex.rpe&&<span><span style={{color:C.textLow,fontSize:11}}>RPE </span><span style={{color:rpeColor(ex.rpe),fontWeight:700}}>{ex.rpe}</span></span>}
              </div>
            )}
          </div>
        ))}
      </div>
      {(training.notes||training.nextFocus)&&(<><SectionTitle>Notities</SectionTitle><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"14px 24px"}}>{training.notes&&<div><div style={{fontSize:11,fontWeight:600,color:C.textLow,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:6}}>Opmerking</div><div style={T.notesBox}>{training.notes}</div></div>}{training.nextFocus&&<div><div style={{fontSize:11,fontWeight:600,color:C.textLow,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:6}}>Focus volgende training</div><div style={{...T.notesBox,borderColor:C.accentDim,color:C.accent}}>📌 {training.nextFocus}</div></div>}</div></>)}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PROGRESSIE
// ─────────────────────────────────────────────────────────────────────────────
function Progressie({client,onBack}) {
  const trainings=[...(client.trainings??[])].reverse();
  const allNames=[...new Set(trainings.flatMap(t=>(t.exercises??[]).map(e=>e.name).filter(Boolean)))];
  const [selected,setSelected]=useState(allNames[0]??"");
  const [clientView,setClientView]=useState(false);
  const data=trainings.flatMap(t=>{
    const matches=(t.exercises??[]).filter(e=>e.name.toLowerCase()===selected.toLowerCase());
    if(!matches.length)return[];
    const best=matches[0];
    // Gebruik setData als beschikbaar, anders het algemene gewicht
    let weight=null,reps=null,sets=0;
    if(best.setData?.length>0){
      const maxSet=best.setData.reduce((a,b)=>(Number(b.weight)||0)>(Number(a.weight)||0)?b:a);
      weight=Number(maxSet.weight)||null;
      reps=Number(maxSet.reps)||null;
      sets=best.setData.length;
    } else {
      weight=Number(best.weight)||null;
      reps=Number(best.reps)||null;
      sets=Number(best.sets)||1;
    }
    const volume=weight&&reps?Math.round(weight*reps*sets):null;
    if(!weight&&!reps)return[];
    return[{date:fmtShort(t.date),weight,reps,volume}];
  });
  const stagnant=data.length>=3&&data.slice(-3).every(d=>d.weight===data[data.length-1].weight);
  const exerciseRows=allNames.map(name=>{const appearances=trainings.flatMap(t=>(t.exercises??[]).filter(e=>e.name.toLowerCase()===name.toLowerCase()).map(e=>({date:t.date,...e})));const last=appearances[appearances.length-1],first=appearances[0];const wChange=last?.weight&&first?.weight?(Number(last.weight)-Number(first.weight)).toFixed(1):null;return{name,count:appearances.length,last,first,wChange};});
  return (
    <>
      {!clientView&&<button style={T.backBtn} onClick={onBack}>← Terug naar {client.name}</button>}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:28,flexWrap:"wrap",gap:12}}>
        <div><h1 style={T.h1}>Progressie</h1><p style={{...T.sub,marginTop:4}}>{client.name}</p></div>
        <button style={{...T.btnSec,borderColor:C.accentDim,color:clientView?C.accent:C.textMid,background:clientView?C.accentDim:"transparent"}}
          onClick={()=>setClientView(p=>!p)}>
          {clientView?"✕ Sluit klantweergave":"👤 Toon aan klant"}
        </button>
      </div>
      {clientView&&(
        <div style={{background:"#0d1a2e",border:`1px solid ${C.accentDim}`,borderRadius:12,padding:"16px 20px",marginBottom:24}}>
          <div style={{fontSize:13,color:C.textMid,lineHeight:1.6}}>
            <strong style={{color:C.accent}}>Progressieoverzicht</strong> voor <strong style={{color:C.text}}>{client.name}</strong>
            <span style={{display:"block",fontSize:12,marginTop:4,color:C.textLow}}>Bekijk hieronder de progressie per oefening over de tijd.</span>
          </div>
        </div>
      )}
      {allNames.length===0?<div style={{padding:"40px 0",color:C.textLow,fontSize:13}}>Nog geen oefeningen gelogd.</div>:(<>
        <SectionTitle>Grafiek</SectionTitle>
        <div style={{marginBottom:20}}><select style={{...T.select,maxWidth:260}} value={selected} onChange={e=>setSelected(e.target.value)}>{allNames.map(n=><option key={n} value={n}>{n}</option>)}</select></div>
        {stagnant&&<div style={{background:"#2a1a00",border:"1px solid #854d0e",borderRadius:8,padding:"10px 14px",fontSize:13,color:C.orange,marginBottom:16}}>⚠️ Mogelijke stagnatie — <strong>{selected}</strong> is de laatste 3 sessies niet gestegen.</div>}
        {data.length<2?<div style={{padding:"20px 0",color:C.textLow,fontSize:13}}>Minimaal 2 meetpunten nodig.</div>:(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:"20px 16px 12px",marginBottom:28}}>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={data} margin={{top:4,right:16,left:0,bottom:4}}>
                <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{fill:C.textLow,fontSize:11}} axisLine={false} tickLine={false} />
                <YAxis yAxisId="left" tick={{fill:C.textLow,fontSize:11}} axisLine={false} tickLine={false} width={38} />
                <YAxis yAxisId="right" orientation="right" tick={{fill:C.textLow,fontSize:11}} axisLine={false} tickLine={false} width={38} />
                <Tooltip contentStyle={{background:C.surfaceHi,border:`1px solid ${C.border}`,borderRadius:8,fontSize:12,color:C.text}} />
                <Legend wrapperStyle={{fontSize:12,color:C.textMid,paddingTop:8}} />
                {data.some(d=>d.weight)&&<Line yAxisId="left" type="monotone" dataKey="weight" name="Gewicht" stroke={C.accent} strokeWidth={2.5} dot={{fill:C.accent,r:4,strokeWidth:0}} activeDot={{r:6}} />}
                {data.some(d=>d.reps)&&<Line yAxisId="right" type="monotone" dataKey="reps" name="Reps" stroke={C.green} strokeWidth={2} strokeDasharray="5 3" dot={{fill:C.green,r:3,strokeWidth:0}} />}
                {data.some(d=>d.volume)&&<Line yAxisId="left" type="monotone" dataKey="volume" name="Volume" stroke={C.orange} strokeWidth={1.5} strokeDasharray="2 4" dot={false} />}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        <SectionTitle>Alle oefeningen</SectionTitle>
        <div style={{overflowX:"auto"}}><table style={T.tbl}><thead><tr>{["Oefening","# keer","Eerste gewicht","Laatste gewicht","Verandering","Laatste techniek"].map(h=><th key={h} style={T.th}>{h}</th>)}</tr></thead>
        <tbody>{exerciseRows.map(row=>{const change=Number(row.wChange);return(<tr key={row.name} style={{cursor:"pointer"}} onClick={()=>{setSelected(row.name);window.scrollTo(0,0);}}><td style={T.tdBold}>{row.name}</td><td style={T.td}>{row.count}</td><td style={T.td}>{row.first?.weight?`${row.first.weight} kg`:"—"}</td><td style={T.td}>{row.last?.weight?`${row.last.weight} kg`:"—"}</td><td style={T.td}>{row.wChange!==null?<span style={{color:change>0?C.green:change<0?C.red:C.textLow,fontWeight:600}}>{change>0?"+":""}{row.wChange} kg</span>:"—"}</td><td style={T.td}><span style={{color:C.yellow}}>{row.last?.technique?techStars(row.last.technique):"—"}</span></td></tr>);})}</tbody></table></div>
      </>)}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AI ANALYSE
// ─────────────────────────────────────────────────────────────────────────────
function AIAnalyse({client,equipment,onBack,onSaveAnalysis,toast}) {
  const [status,setStatus]=useState("idle");
  const [result,setResult]=useState(null);
  const [tab,setTab]=useState("new");
  const trainings=client.trainings??[];
  const history=client.aiAnalyses??[];
  const buildPrompt=()=>{
    const availableExercises=equipment.flatMap(eq=>eq.exercises.map(e=>`${e.name} (${eq.name})`)).join(", ");
    const profile=`Klantprofiel:\n- Naam: ${client.name}\n- Doel: ${GOAL_OPTIONS.find(g=>g.value===client.goal)?.label??client.goal}\n- Frequentie: ${client.frequency?client.frequency+"x/week":"onbekend"}\n- Blessures: ${client.injuries||"geen"}\n- Voorkeur: ${client.preferredExercises||"geen"}\n- Niet-fijn: ${client.dislikedExercises||"geen"}\n- Focus: ${client.currentFocus||"geen"}\n- Notities: ${client.notes||"geen"}\n- Beschikbare oefeningen: ${availableExercises}`;
    const recentTrainings=[...trainings].slice(0,10).map((t,i)=>{const exLines=(t.exercises??[]).map(e=>`    - ${e.name||"?"}: ${e.sets||"?"}x${e.reps||"?"} @ ${e.weight||"?"}kg, RPE ${e.rpe||"?"}, Tech ${e.technique?e.technique+"/5":"?"}`).join("\n");return `Training ${i+1} (${fmtDate(t.date)}):\n  Energie: ${t.energy?ENERGY_LABELS[t.energy]:"?"}\n  Klachten: ${t.complaints||"geen"}\n${exLines}\n  Focus volgende: ${t.nextFocus||"—"}`;}).join("\n\n");
    return `Je bent een PT-coach assistent. Analyseer de klantdata en geef advies. Gebruik ALLEEN beschikbare oefeningen. Trainer beslist altijd.\n\n${profile}\n\nLaatste trainingen:\n${recentTrainings||"Geen."}\n\nGeef analyse als JSON (geen markdown):\n{"progressie":["punt"],"stagnatie":["punt"],"spiergroepen":["punt"],"oefeningen":["punt"],"volgendeFocus":["punt"],"samenvatting":"2-3 zinnen"}\nMax 4 punten per array.`;
  };
  const runAnalysis=async()=>{
    setStatus("loading");setResult(null);
    try{const text=await callClaude([{role:"user",content:buildPrompt()}],1000);const parsed=JSON.parse(text.replace(/```json|```/g,"").trim());const withDate={...parsed,date:new Date().toISOString()};setResult(withDate);setStatus("done");onSaveAnalysis(client.id,withDate);toast("Analyse opgeslagen");}
    catch{setStatus("error");toast("Analyse mislukt","error");}
  };
  const SECTIONS=[{key:"progressie",icon:"📈",label:"Progressie"},{key:"stagnatie",icon:"⚠️",label:"Stagnatie"},{key:"spiergroepen",icon:"💪",label:"Spiergroepbalans"},{key:"oefeningen",icon:"🔄",label:"Oefeningsuggesties"},{key:"volgendeFocus",icon:"🎯",label:"Focus volgende training"}];
  const AnalysisResult=({r})=>(<><div style={{...T.aiBox,marginBottom:16}}><div style={T.aiTitle}>✦ Samenvatting</div><p style={{fontSize:14,color:C.text,lineHeight:1.7,margin:0}}>{r.samenvatting}</p></div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:20}}>{SECTIONS.map(({key,icon,label})=>{const items=r[key];if(!items?.length)return null;return(<div key={key} style={T.aiBox}><div style={T.aiTitle}>{icon} {label}</div><ul style={{margin:0,paddingLeft:18}}>{items.map((item,i)=><li key={i} style={{fontSize:13,color:C.textMid,lineHeight:1.7,marginBottom:4}}>{item}</li>)}</ul></div>);})}</div></>);
  return (
    <>
      <button style={T.backBtn} onClick={onBack}>← Terug naar {client.name}</button>
      <div style={{marginBottom:8}}><h1 style={T.h1}>AI-analyse</h1><p style={{...T.sub,marginTop:4}}>{client.name}</p></div>
      <div style={{background:"#1a2236",border:`1px solid ${C.accentDim}`,borderRadius:10,padding:"12px 16px",fontSize:13,color:C.textMid,marginBottom:24,lineHeight:1.6}}><strong style={{color:C.accent}}>✦ AI-assistent</strong> — Suggesties op basis van data. Jij beslist altijd.</div>
      <div style={{display:"flex",gap:0,marginBottom:24,background:C.surface,borderRadius:8,border:`1px solid ${C.border}`,overflow:"hidden",width:"fit-content"}}>
        {[["new","Nieuwe analyse"],["history",`Geschiedenis (${history.length})`]].map(([key,label])=>(<button key={key} style={{background:tab===key?C.accent:"transparent",color:tab===key?"#fff":C.textMid,border:"none",padding:"8px 18px",cursor:"pointer",fontSize:13,fontWeight:tab===key?600:500,fontFamily:"inherit"}} onClick={()=>setTab(key)}>{label}</button>))}
      </div>
      {tab==="new"&&(<>{trainings.length===0&&<div style={{padding:"20px 0",color:C.textLow,fontSize:13}}>Log eerst minimaal één training.</div>}{trainings.length>0&&status==="idle"&&<button style={{...T.btnPrimary,fontSize:14,padding:"11px 24px"}} onClick={runAnalysis}>✦ Analyse starten</button>}{status==="loading"&&<div style={T.aiBox}><div style={{...T.aiTitle,marginBottom:0}}><span style={{display:"inline-block",animation:"spin 1s linear infinite"}}>⟳</span> Analyse bezig…</div><style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style></div>}{status==="error"&&<div style={{background:"#2a0a0a",border:"1px solid #7f1d1d",borderRadius:10,padding:"16px 20px"}}><div style={{color:C.red,fontWeight:700,marginBottom:8}}>Mislukt</div><button style={T.btnPrimary} onClick={runAnalysis}>Opnieuw</button></div>}{status==="done"&&result&&<><AnalysisResult r={result} /><button style={T.btnSec} onClick={runAnalysis}>↺ Nieuwe analyse</button></>}</>)}
      {tab==="history"&&(<>{history.length===0?<div style={{padding:"20px 0",color:C.textLow,fontSize:13}}>Nog geen analyses bewaard.</div>:history.map((r,i)=>(<div key={i} style={{marginBottom:32}}><div style={{fontSize:13,fontWeight:700,color:C.textMid,marginBottom:12,display:"flex",alignItems:"center",gap:10}}><span style={{background:C.accentDim,color:C.accent,borderRadius:5,padding:"2px 8px",fontSize:11}}>Analyse {history.length-i}</span>{fmtDate(r.date?.slice(0,10))}</div><AnalysisResult r={r} />{i<history.length-1&&<hr style={{border:"none",borderTop:`1px solid ${C.border}`,marginTop:24}} />}</div>))}</>)}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
function Settings({equipment,setEquipment,toast,onBack}) {
  const [expandedEq,setExpandedEq]=useState(null);
  const [newEqName,setNewEqName]=useState("");
  const [newExInputs,setNewExInputs]=useState({});
  const [editingEx,setEditingEx]=useState(null);
  const addEquipment=()=>{if(!newEqName.trim())return;const newEq={id:uid(),name:newEqName.trim(),exercises:[]};setEquipment([...equipment,newEq]);setNewEqName("");setExpandedEq(newEq.id);toast("Apparaat toegevoegd");};
  const deleteEquipment=(eqId)=>{if(!window.confirm("Verwijderen?"))return;setEquipment(equipment.filter(eq=>eq.id!==eqId));toast("Apparaat verwijderd");};
  const addExercise=(eqId)=>{const inp=newExInputs[eqId];if(!inp?.name?.trim())return;const newEx={id:uid(),name:inp.name.trim(),muscles:inp.muscles??[]};setEquipment(equipment.map(eq=>eq.id===eqId?{...eq,exercises:[...eq.exercises,newEx]}:eq));setNewExInputs(p=>({...p,[eqId]:{name:"",muscles:[]}}));toast("Oefening toegevoegd");};
  const deleteExercise=(eqId,exId)=>{setEquipment(equipment.map(eq=>eq.id===eqId?{...eq,exercises:eq.exercises.filter(e=>e.id!==exId)}:eq));toast("Oefening verwijderd");};
  const saveEditEx=()=>{if(!editingEx)return;setEquipment(equipment.map(eq=>eq.id===editingEx.eqId?{...eq,exercises:eq.exercises.map(e=>e.id===editingEx.exId?{...e,name:editingEx.name,muscles:editingEx.muscles}:e)}:eq));setEditingEx(null);toast("Oefening opgeslagen");};
  const toggleMuscle=(muscle,current,setter)=>{const arr=current??[];setter(arr.includes(muscle)?arr.filter(m=>m!==muscle):[...arr,muscle]);};
  const MuscleSelector=({selected,onChange})=>(<div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:4}}>{MUSCLE_GROUPS.map(m=>(<button key={m} style={{background:selected?.includes(m)?C.accentDim:"transparent",color:selected?.includes(m)?C.accent:C.textLow,border:`1px solid ${selected?.includes(m)?C.accent+"55":C.border}`,borderRadius:5,padding:"3px 8px",cursor:"pointer",fontSize:11,fontFamily:"inherit"}} onClick={()=>toggleMuscle(m,selected,onChange)}>{m}</button>))}</div>);
  const totalExercises=equipment.reduce((s,eq)=>s+eq.exercises.length,0);
  return (
    <>
      <button style={T.backBtn} onClick={onBack}>← Terug</button>
      <div style={{marginBottom:24}}><h1 style={T.h1}>Instellingen</h1><p style={{...T.sub,marginTop:4}}>{equipment.length} apparaten · {totalExercises} oefeningen</p></div>
      <div style={{background:"#1a2236",border:`1px solid ${C.accentDim}`,borderRadius:10,padding:"12px 16px",fontSize:13,color:C.textMid,marginBottom:28,lineHeight:1.6}}>Beheer hier de apparatuur en oefeningen van jouw studio.</div>
      {equipment.map(eq=>(
        <div key={eq.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,marginBottom:10,overflow:"hidden"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"16px 20px",cursor:"pointer"}} onClick={()=>setExpandedEq(expandedEq===eq.id?null:eq.id)}>
            <div><span style={{fontWeight:700,color:C.text,fontSize:15}}>{eq.name}</span><span style={{fontSize:12,color:C.textLow,marginLeft:10}}>{eq.exercises.length} oefeningen</span></div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}><button style={{...T.btnGhost,color:C.red,fontSize:12}} onClick={e=>{e.stopPropagation();deleteEquipment(eq.id);}}>Verwijderen</button><span style={{color:C.textLow,fontSize:16}}>{expandedEq===eq.id?"↑":"›"}</span></div>
          </div>
          {expandedEq===eq.id&&(
            <div style={{borderTop:`1px solid ${C.border}`,padding:"16px 20px"}}>
              {eq.exercises.length===0&&<div style={{fontSize:13,color:C.textLow,marginBottom:16}}>Nog geen oefeningen.</div>}
              {eq.exercises.map(ex=>(
                <div key={ex.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:`1px solid ${C.border}`}}>
                  {editingEx?.exId===ex.id?(<div style={{flex:1,marginRight:12}}><input style={{...T.input,marginBottom:8}} value={editingEx.name} onChange={e=>setEditingEx(p=>({...p,name:e.target.value}))} /><MuscleSelector selected={editingEx.muscles} onChange={muscles=>setEditingEx(p=>({...p,muscles}))} /></div>):(<div><span style={{fontSize:13,color:C.text,fontWeight:500}}>{ex.name}</span>{ex.muscles?.length>0&&<span style={{fontSize:11,color:C.textLow,marginLeft:8}}>{ex.muscles.join(", ")}</span>}</div>)}
                  <div style={{display:"flex",gap:8,flexShrink:0}}>
                    {editingEx?.exId===ex.id?(<><button style={{...T.btnSmall,fontSize:11}} onClick={saveEditEx}>Opslaan</button><button style={{...T.btnGhost,color:C.textLow,fontSize:12}} onClick={()=>setEditingEx(null)}>Annuleer</button></>):(<><button style={{...T.btnGhost,color:C.textMid,fontSize:12}} onClick={()=>setEditingEx({eqId:eq.id,exId:ex.id,name:ex.name,muscles:[...(ex.muscles??[])]})}>Bewerk</button><button style={{...T.btnGhost,color:C.red,fontSize:12}} onClick={()=>deleteExercise(eq.id,ex.id)}>✕</button></>)}
                  </div>
                </div>
              ))}
              <div style={{marginTop:16}}>
                <div style={{fontSize:11,fontWeight:700,color:C.textLow,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>Oefening toevoegen</div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"flex-start"}}>
                  <input style={{...T.input,maxWidth:260}} value={newExInputs[eq.id]?.name??""} placeholder="Naam oefening" onChange={e=>setNewExInputs(p=>({...p,[eq.id]:{...p[eq.id],name:e.target.value}}))} onKeyDown={e=>e.key==="Enter"&&addExercise(eq.id)} />
                  <button style={T.btnSmall} onClick={()=>addExercise(eq.id)}>Toevoegen</button>
                </div>
                <MuscleSelector selected={newExInputs[eq.id]?.muscles??[]} onChange={muscles=>setNewExInputs(p=>({...p,[eq.id]:{...p[eq.id],muscles}}))} />
              </div>
            </div>
          )}
        </div>
      ))}
      <SectionTitle>Apparaat toevoegen</SectionTitle>
      <div style={{display:"flex",gap:10,alignItems:"center"}}>
        <input style={{...T.input,maxWidth:280}} value={newEqName} placeholder="bijv. Smith machine" onChange={e=>setNewEqName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addEquipment()} />
        <button style={T.btnPrimary} onClick={addEquipment}>Toevoegen</button>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GROEPSTRAINING
// ─────────────────────────────────────────────────────────────────────────────
function GroupTraining({clients,equipment,onSave,onCancel,toast}) {
  const [forms,setForms]=useState(()=>Object.fromEntries(clients.map(c=>[c.id,blankTraining()])));
  const [activeTab,setActiveTab]=useState(clients[0]?.id??null);
  const [pickerOpen,setPickerOpen]=useState({});
  const [aiSugs,setAiSugs]=useState({});
  const [aiLoading,setAiLoading]=useState({});
  const [muscleFilter,setMuscleFilter]=useState("Alle");
  const [eqFilter,setEqFilter]=useState("Alle");
  const setF=(cId,k,v)=>setForms(p=>({...p,[cId]:{...p[cId],[k]:v}}));
  const setEx=(cId,exId,k,v)=>setForms(p=>({...p,[cId]:{...p[cId],exercises:p[cId].exercises.map(e=>e.id===exId?{...e,[k]:v}:e)}}));
  const addEx=(cId)=>setForms(p=>({...p,[cId]:{...p[cId],exercises:[...p[cId].exercises,blankExercise()]}}));
  const removeEx=(cId,exId)=>setForms(p=>({...p,[cId]:{...p[cId],exercises:p[cId].exercises.filter(e=>e.id!==exId)}}));
  const allExercises=equipment.flatMap(eq=>eq.exercises.map(ex=>({...ex,equipment:eq.name})));
  const filteredExercises=allExercises.filter(ex=>(muscleFilter==="Alle"||ex.muscles.includes(muscleFilter))&&(eqFilter==="Alle"||ex.equipment===eqFilter));
  const pickExercise=(cId,exName)=>{const used=new Set(forms[cId].exercises.map(e=>e.name.toLowerCase()).filter(Boolean));if(used.has(exName.toLowerCase()))return;const emptyIdx=forms[cId].exercises.findIndex(e=>!e.name.trim());if(emptyIdx>=0){setForms(p=>({...p,[cId]:{...p[cId],exercises:p[cId].exercises.map((e,i)=>i===emptyIdx?{...e,name:exName}:e)}}));}else{addEx(cId);setTimeout(()=>setForms(p=>{const exs=p[cId].exercises;return{...p,[cId]:{...p[cId],exercises:exs.map((e,i)=>i===exs.length-1?{...e,name:exName}:e)}};}),0);}};
  const fetchAISuggestions=async(cId)=>{setAiLoading(p=>({...p,[cId]:true}));const client=clients.find(c=>c.id===cId);const availableNames=allExercises.map(e=>e.name).join(", ");const recentUnique=[...new Set((client.trainings??[]).slice(0,5).flatMap(t=>(t.exercises??[]).map(e=>e.name)).filter(Boolean))].join(", ");const prompt=`PT coach assistent. Stel 5 oefeningen voor.\nKlant: ${client.name}, Doel: ${GOAL_OPTIONS.find(g=>g.value===client.goal)?.label??client.goal}, Blessures: ${client.injuries||"geen"}, Focus: ${client.currentFocus||"geen"}, Niet-fijn: ${client.dislikedExercises||"geen"}, Recent: ${recentUnique||"onbekend"}\nBeschikbaar: ${availableNames}\nJSON array (geen markdown): [{"name":"naam exact","reason":"1 zin"},...]`;try{const text=await callClaude([{role:"user",content:prompt}],600);setAiSugs(p=>({...p,[cId]:JSON.parse(text.replace(/```json|```/g,"").trim())}));}catch{toast("AI-suggesties mislukt","error");}setAiLoading(p=>({...p,[cId]:false}));};
  const handleSave=()=>{const trainingsMap=Object.fromEntries(clients.map(c=>[c.id,{...forms[c.id],id:uid()}]));onSave(trainingsMap);};
  const activeClient=clients.find(c=>c.id===activeTab);const form=activeTab?forms[activeTab]:null;
  return (
    <>
      <button style={T.backBtn} onClick={onCancel}>← Terug naar dashboard</button>
      <div style={{marginBottom:24}}><h1 style={{...T.h1,marginBottom:6}}>Groepstraining</h1><p style={T.sub}>{clients.map(c=>c.name).join(", ")} · {new Date().toLocaleDateString("nl-NL",{day:"numeric",month:"long"})}</p></div>
      <div style={{display:"flex",gap:0,marginBottom:24,background:C.surface,borderRadius:10,border:`1px solid ${C.border}`,overflow:"hidden"}}>
        {clients.map(c=>{const exCount=forms[c.id]?.exercises?.filter(e=>e.name.trim()).length??0;const isActive=activeTab===c.id;return(<button key={c.id} style={{flex:1,background:isActive?C.bg:"transparent",color:isActive?C.text:C.textMid,border:"none",borderRight:`1px solid ${C.border}`,padding:"14px 12px",cursor:"pointer",fontFamily:"inherit",textAlign:"center"}} onClick={()=>setActiveTab(c.id)}><div style={{fontWeight:isActive?700:500,fontSize:13,marginBottom:3}}>{c.name}</div><div style={{fontSize:11,color:isActive?C.accent:C.textLow}}>{exCount>0?`${exCount} oefening${exCount!==1?"en":""}` :"Leeg"}</div></button>);})}
      </div>
      {activeClient&&form&&(
        <div style={T.form}>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20,flexWrap:"wrap"}}><h2 style={T.h2}>{activeClient.name}</h2><GoalBadge value={activeClient.goal} />{activeClient.injuries&&<Badge color={C.orange}>⚠️ {activeClient.injuries}</Badge>}</div>
          <div style={{...T.formGrid,marginBottom:20}}>
            <div style={T.fg}><label style={T.lbl}>Datum</label><input type="date" style={T.input} value={form.date} onChange={e=>setF(activeTab,"date",e.target.value)} /></div>
            <div style={T.fg}><label style={T.lbl}>Energie (1–5)</label><select style={T.select} value={form.energy} onChange={e=>setF(activeTab,"energy",e.target.value)}><option value="">— Kies —</option>{[1,2,3,4,5].map(n=><option key={n} value={n}>{n} – {ENERGY_LABELS[n]}</option>)}</select></div>
            <div style={T.fgFull}><label style={T.lbl}>Klachten of pijn</label><input style={T.input} value={form.complaints} placeholder="bijv. schouderpijn" onChange={e=>setF(activeTab,"complaints",e.target.value)} /></div>
            <div style={T.fgFull}><label style={T.lbl}>Focus volgende training</label><input style={T.input} value={form.nextFocus} placeholder="bijv. meer squat volume" onChange={e=>setF(activeTab,"nextFocus",e.target.value)} /></div>
          </div>
          <div style={{borderTop:`1px solid ${C.border}`,paddingTop:20}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
              <h3 style={T.h3}>Oefeningen</h3>
              <button style={{...T.btnSec,borderColor:C.accentDim,color:C.accent,fontSize:12,padding:"6px 12px"}} onClick={()=>{const wasOpen=pickerOpen[activeTab];setPickerOpen(p=>({...p,[activeTab]:!wasOpen}));if(!wasOpen&&!aiSugs[activeTab]&&!aiLoading[activeTab])fetchAISuggestions(activeTab);}}>{pickerOpen[activeTab]?"✕ Sluiten":"🗂 Oefeningen kiezen"}</button>
            </div>
            {pickerOpen[activeTab]&&(
              <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:12,padding:20,marginBottom:16}}>
                <div style={{marginBottom:16}}>
                  <div style={{fontSize:12,fontWeight:700,color:C.accent,marginBottom:8}}>✦ AI-suggesties voor {activeClient.name}{aiLoading[activeTab]&&<span style={{color:C.textLow,fontWeight:400,marginLeft:6}}>laden…</span>}</div>
                  {aiSugs[activeTab]?.length>0&&(<div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:8}}>{aiSugs[activeTab].map((s,i)=>{const used=new Set(form.exercises.map(e=>e.name.toLowerCase()).filter(Boolean));const already=used.has(s.name.toLowerCase());return(<button key={i} title={s.reason} style={{background:already?"#1a2236":C.accentDim,color:already?C.textLow:C.accent,border:`1px solid ${already?C.border:C.accent+"55"}`,borderRadius:7,padding:"7px 12px",cursor:already?"default":"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",opacity:already?0.5:1}} onClick={()=>!already&&pickExercise(activeTab,s.name)}>{already?"✓ ":""}{s.name}</button>);})}</div>)}
                  {aiSugs[activeTab]&&<button style={{...T.btnGhost,color:C.textLow,fontSize:12}} onClick={()=>fetchAISuggestions(activeTab)}>↺ Nieuwe suggesties</button>}
                </div>
                {/* Spiergroep tabs */}
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
                  {["Alle",...MUSCLE_GROUPS].map(m=>(
                    <button key={m}
                      style={{background:muscleFilter===m?C.accent:"transparent",color:muscleFilter===m?"#fff":C.textMid,border:`1px solid ${muscleFilter===m?C.accent:C.border}`,borderRadius:20,padding:"5px 12px",cursor:"pointer",fontSize:12,fontWeight:muscleFilter===m?700:400,fontFamily:"inherit",whiteSpace:"nowrap"}}
                      onClick={()=>setMuscleFilter(m)}>{m}
                    </button>
                  ))}
                </div>
                {/* Per apparaat */}
                {equipment.filter(eq=>eq.exercises.some(ex=>muscleFilter==="Alle"||ex.muscles.includes(muscleFilter))).map(eq=>{
                  const exs=eq.exercises.filter(ex=>muscleFilter==="Alle"||ex.muscles.includes(muscleFilter));
                  if(!exs.length) return null;
                  const used=new Set(form.exercises.map(e=>e.name.toLowerCase()).filter(Boolean));
                  return (
                    <div key={eq.id} style={{marginBottom:14}}>
                      <div style={{fontSize:11,fontWeight:700,color:C.textLow,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6,paddingBottom:4,borderBottom:`1px solid ${C.border}`}}>{eq.name}</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                        {exs.map(ex=>{const already=used.has(ex.name.toLowerCase());return(
                          <button key={ex.id}
                            style={{background:already?C.accentDim:"#1a2236",color:already?C.accent:C.textMid,border:`1px solid ${already?C.accent+"55":C.border}`,borderRadius:20,padding:"6px 14px",cursor:already?"default":"pointer",fontSize:12,fontWeight:already?700:500,fontFamily:"inherit",whiteSpace:"nowrap"}}
                            onClick={()=>!already&&pickExercise(activeTab,ex.name)}>
                            {already&&"✓ "}{ex.name}
                          </button>
                        );})}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {form.exercises.map((ex,idx)=>(
              <ExerciseBlock key={ex.id} ex={ex} idx={idx} canRemove={form.exercises.length>1}
                onRemove={()=>removeEx(activeTab,ex.id)}
                onChange={(k,v)=>setEx(activeTab,ex.id,k,v)}
                onSetChange={(sid,k,v)=>setForms(p=>({...p,[activeTab]:{...p[activeTab],exercises:p[activeTab].exercises.map(e=>e.id===ex.id?{...e,setData:e.setData.map(s=>s.id===sid?{...s,[k]:v}:s)}:e)}}))}
                onAddSet={()=>setForms(p=>({...p,[activeTab]:{...p[activeTab],exercises:p[activeTab].exercises.map(e=>e.id===ex.id?{...e,setData:[...(e.setData||[]),blankSet()]}:e)}}))}
                onRemoveSet={(sid)=>setForms(p=>({...p,[activeTab]:{...p[activeTab],exercises:p[activeTab].exercises.map(e=>e.id===ex.id?{...e,setData:(e.setData||[]).filter(s=>s.id!==sid)}:e)}}))}
              />
            ))}
            <button style={{...T.btnSec,width:"100%",marginTop:4}} onClick={()=>addEx(activeTab)}>+ Oefening toevoegen</button>
          </div>
        </div>
      )}
      <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:20}}>
        <button style={T.btnSec} onClick={onCancel}>Annuleren</button>
        <button style={T.btnPrimary} onClick={handleSave}>💾 Alle trainingen opslaan ({clients.length})</button>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INBODY — velden definitie met uitleg en gezonde bereiken
// ─────────────────────────────────────────────────────────────────────────────
const INBODY_FIELDS = [
  { key:"gewicht", label:"Gewicht", unit:"kg", group:"Basis",
    info:"Je totale lichaamsgewicht. Op zichzelf zegt dit weinig — het gaat om de verhouding tussen spier en vet." },
  { key:"skeletspiermassa", label:"Skeletspiermassa (SSM)", unit:"kg", group:"Basis", higherBetter:true,
    info:"De spieren die je bewust aanstuurt. Meer spiermassa betekent een sterker, gezonder lichaam en een hogere verbranding in rust. Dit wil je zien stijgen." },
  { key:"vetmassa", label:"Vetmassa", unit:"kg", group:"Basis", lowerBetter:true,
    info:"Totale hoeveelheid lichaamsvet in kilo's. Een deel vet is essentieel, maar te veel verhoogt gezondheidsrisico's. Idealiter daalt dit terwijl spiermassa gelijk blijft of stijgt." },
  { key:"vetpercentage", label:"Vetpercentage", unit:"%", group:"Basis", lowerBetter:true,
    info:"Het percentage van je gewicht dat uit vet bestaat. Gezond: mannen 10-20%, vrouwen 18-28%. Dit is een betere maatstaf dan gewicht of BMI.",
    range:{ man:[10,20], vrouw:[18,28] } },
  { key:"bmi", label:"BMI", unit:"kg/m²", group:"Basis",
    info:"Gewicht gedeeld door lengte in het kwadraat. Gezond bereik volgens de WHO is 18.5-25. Let op: BMI houdt geen rekening met spiermassa, dus gespierde mensen scoren soms 'te hoog' terwijl ze gezond zijn.",
    range:{ algemeen:[18.5,25] } },
  { key:"visceraalvet", label:"Visceraal vetniveau", unit:"", group:"Gezondheid", lowerBetter:true,
    info:"Vet rondom je organen in de buik. Dit is het gevaarlijkste vet — het verhoogt het risico op hart- en vaatziekten en diabetes. Een niveau onder de 10 is gezond, daaronder hoe lager hoe beter.",
    range:{ algemeen:[1,9] } },
  { key:"basaalmetabolisme", label:"Basaalmetabolisme (BMR)", unit:"kcal", group:"Gezondheid", higherBetter:true,
    info:"Het aantal calorieën dat je lichaam in rust per dag verbruikt om te functioneren. Meer spiermassa verhoogt dit getal. Handig om de calorie-inname op af te stemmen." },
  { key:"inbodyscore", label:"InBody Score", unit:"/100", group:"Gezondheid", higherBetter:true,
    info:"Een totaalscore van je lichaamssamenstelling. 70-80 is normaal en gezond. Boven de 80 betekent veel spier en weinig vet — heel goed bezig. Een gespierd persoon kan boven de 100 uitkomen.",
    range:{ algemeen:[70,100] } },
  { key:"streefgewicht", label:"Streefgewicht", unit:"kg", group:"Gezondheid",
    info:"Het gewicht dat de InBody aanraadt op basis van een gezonde lichaamssamenstelling voor lengte en geslacht." },
  { key:"lichaamswater", label:"Totaal lichaamswater", unit:"L", group:"Gevorderd",
    info:"De totale hoeveelheid water in je lichaam. Schommelt met hydratatie en inspanning. Een stabiel niveau over metingen is normaal." },
  { key:"eiwitten", label:"Eiwitten", unit:"kg", group:"Gevorderd", higherBetter:true,
    info:"De eiwitmassa in je lichaam, een bouwsteen van spierweefsel. Stijgt mee met spiergroei." },
  { key:"mineralen", label:"Mineralen", unit:"kg", group:"Gevorderd",
    info:"Mineralen in botten en weefsel. Geeft een indicatie van botgezondheid." },
  { key:"skeletspierindex", label:"Skeletspier Index (SMI)", unit:"kg/m²", group:"Gevorderd", higherBetter:true,
    info:"Spiermassa gecorrigeerd voor lengte. Wordt gebruikt om te beoordelen of iemand voldoende spier heeft (tegenovergestelde van sarcopenie/spierverlies)." },
  { key:"middelheupratio", label:"Middel-heup ratio", unit:"", group:"Gevorderd", lowerBetter:true,
    info:"De verhouding tussen je taille en heupen. Een lagere waarde betekent minder buikvet en een lager gezondheidsrisico. Gezond: mannen onder 0.90, vrouwen onder 0.85." },
];
const INBODY_GROUPS = ["Basis","Gezondheid","Gevorderd"];

// Bepaal status van een waarde (goed / let op / hoog)
function inbodyStatus(field, value, gender) {
  if (!field.range || value === "" || value == null) return null;
  const num = Number(value);
  if (isNaN(num)) return null;
  let range = field.range.algemeen;
  if (!range && gender) range = gender.toLowerCase().startsWith("v") ? field.range.vrouw : field.range.man;
  if (!range) return null;
  const [min, max] = range;
  if (num < min) return field.lowerBetter ? { txt:"Uitstekend", color:C.green } : { txt:"Aan de lage kant", color:C.yellow };
  if (num > max) return field.lowerBetter ? { txt:"Te hoog — aandachtspunt", color:C.red } : { txt:"Boven gemiddeld", color:num>max*1.2?C.red:C.yellow };
  return { txt:"Gezond bereik", color:C.green };
}

// ─────────────────────────────────────────────────────────────────────────────
// INBODY ADD — foto uploaden/maken en door AI laten uitlezen
// ─────────────────────────────────────────────────────────────────────────────
function InbodyAdd({ client, onSave, onCancel, toast }) {
  const [status, setStatus] = useState("idle"); // idle | reading | review
  const [data, setData] = useState({});
  const [date, setDate] = useState(new Date().toISOString().slice(0,10));
  const [gender, setGender] = useState("");
  const fileRef = useRef();

  const handleFile = async (file) => {
    if (!file) return;
    setStatus("reading");
    try {
      // Lees als base64
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      const mediaType = file.type || "image/jpeg";

      const fieldList = INBODY_FIELDS.map(f => `"${f.key}"`).join(", ");
      const prompt = `Dit is een foto van een InBody lichaamsanalyse uitdraai. Lees alle waarden nauwkeurig uit. Geef ALLEEN een JSON object terug (geen markdown), met deze keys (laat een key weg als de waarde niet leesbaar is): ${fieldList}, en "geslacht" (man of vrouw).

Gebruik punten voor decimalen. Geef alleen het getal, geen eenheden. Bijvoorbeeld: {"gewicht": 68.0, "vetpercentage": 30.0, "geslacht": "vrouw"}`;

      const messages = [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: prompt },
        ],
      }];

      const text = await callClaude(messages, 1500);
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      const g = parsed.geslacht || "";
      delete parsed.geslacht;
      setData(parsed);
      setGender(g);
      setStatus("review");
      toast("Waarden uitgelezen — controleer ze");
    } catch (e) {
      console.error(e);
      toast("Uitlezen mislukt — vul handmatig in of probeer opnieuw", "error");
      setStatus("review");
    }
  };

  const setField = (k, v) => setData(p => ({ ...p, [k]: v }));

  const handleSave = () => {
    onSave({ id: uid(), date, data: { ...data, geslacht: gender } });
  };

  return (
    <>
      <button style={T.backBtn} onClick={onCancel}>← Terug</button>
      <div style={{marginBottom:24}}>
        <h1 style={T.h1}>InBody toevoegen</h1>
        <p style={{...T.sub,marginTop:4}}>{client.name}</p>
      </div>

      {status === "idle" && (
        <div style={T.form}>
          <div style={{textAlign:"center",padding:"20px 0 32px"}}>
            <div style={{fontSize:44,marginBottom:14}}>⚖️</div>
            <div style={{fontSize:15,fontWeight:600,color:C.text,marginBottom:8}}>Maak of upload een foto van de InBody-uitdraai</div>
            <div style={{fontSize:13,color:C.textMid,marginBottom:28,lineHeight:1.6,maxWidth:420,margin:"0 auto 28px"}}>
              De AI leest automatisch alle waarden uit. Daarna kun je ze controleren en aanpassen voordat je opslaat.
            </div>
            <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap",marginBottom:8}}>
              <button style={{...T.btnPrimary,fontSize:14,padding:"12px 24px"}} onClick={()=>{fileRef.current.removeAttribute("capture");fileRef.current.click();}}>
                🖼 Kies uit galerij
              </button>
              <button style={{...T.btnSec,fontSize:14,padding:"12px 24px"}} onClick={()=>{fileRef.current.setAttribute("capture","environment");fileRef.current.click();}}>
                📷 Camera
              </button>
            </div>
            <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}}
              onChange={e=>handleFile(e.target.files?.[0])} />
            <div style={{marginTop:20}}>
              <button style={{...T.btnGhost,fontSize:13,color:C.textLow}} onClick={()=>{setStatus("review");setData({});}}>
                Of vul handmatig in →
              </button>
            </div>
          </div>
        </div>
      )}

      {status === "reading" && (
        <div style={T.form}>
          <div style={{textAlign:"center",padding:"50px 0"}}>
            <div style={{width:36,height:36,border:`3px solid ${C.border}`,borderTop:`3px solid ${C.accent}`,borderRadius:"50%",animation:"spin 0.8s linear infinite",margin:"0 auto 20px"}} />
            <div style={{fontSize:14,color:C.text,fontWeight:600,marginBottom:6}}>De AI leest de uitdraai uit…</div>
            <div style={{fontSize:13,color:C.textLow}}>Dit duurt een paar seconden.</div>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        </div>
      )}

      {status === "review" && (
        <div style={T.form}>
          <h2 style={{...T.h2,marginBottom:6}}>Controleer de waarden</h2>
          <p style={{...T.sub,marginBottom:20}}>Pas aan waar nodig. Lege velden worden niet opgeslagen.</p>

          <div style={{...T.formGrid,marginBottom:20}}>
            <div style={T.fg}>
              <label style={T.lbl}>Datum meting</label>
              <input type="date" style={T.input} value={date} onChange={e=>setDate(e.target.value)} />
            </div>
            <div style={T.fg}>
              <label style={T.lbl}>Geslacht (voor normen)</label>
              <select style={T.select} value={gender} onChange={e=>setGender(e.target.value)}>
                <option value="">— Kies —</option>
                <option value="man">Man</option>
                <option value="vrouw">Vrouw</option>
              </select>
            </div>
          </div>

          {INBODY_GROUPS.map(group => (
            <div key={group} style={{marginBottom:8}}>
              <div style={{...T.sectionTitle,marginTop:16}}>{group}</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:"12px 16px"}}>
                {INBODY_FIELDS.filter(f=>f.group===group).map(f=>{
                  const st = inbodyStatus(f, data[f.key], gender);
                  return (
                    <div key={f.key} style={T.fg}>
                      <label style={T.lbl}>{f.label}{f.unit&&` (${f.unit})`}</label>
                      <input style={T.input} type="number" step="0.1" value={data[f.key]??""} placeholder="—"
                        onChange={e=>setField(f.key, e.target.value)} />
                      {st && <span style={{fontSize:11,color:st.color,fontWeight:600,marginTop:2}}>{st.txt}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div style={T.formFoot}>
            <button style={T.btnSec} onClick={onCancel}>Annuleren</button>
            <button style={T.btnPrimary} onClick={handleSave}>Meting opslaan</button>
          </div>
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INBODY OVERVIEW — metingen, uitleg per waarde, grafieken over tijd
// ─────────────────────────────────────────────────────────────────────────────
function InbodyOverview({ client, onBack, onNew, onDelete }) {
  const measurements = [...(client.inbody ?? [])]; // nieuwste eerst (al gesorteerd)
  const [expandedInfo, setExpandedInfo] = useState(null);
  const [selectedMetric, setSelectedMetric] = useState("vetpercentage");

  const latest = measurements[0];
  const gender = latest?.data?.geslacht || "";

  // Data voor grafiek (oud → nieuw)
  const chartData = [...measurements].reverse()
    .filter(m => m.data[selectedMetric] != null && m.data[selectedMetric] !== "")
    .map(m => ({ date: fmtShort(m.date), value: Number(m.data[selectedMetric]) }));

  const metricField = INBODY_FIELDS.find(f => f.key === selectedMetric);

  return (
    <>
      <button style={T.backBtn} onClick={onBack}>← Terug naar {client.name}</button>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:24,flexWrap:"wrap",gap:12}}>
        <div><h1 style={T.h1}>InBody-metingen</h1><p style={{...T.sub,marginTop:4}}>{client.name}</p></div>
        <button style={T.btnPrimary} onClick={onNew}>+ Meting toevoegen</button>
      </div>

      {measurements.length === 0 ? (
        <div style={{textAlign:"center",padding:"60px 24px",color:C.textLow}}>
          <div style={{fontSize:44,marginBottom:14}}>⚖️</div>
          <div style={{fontSize:15,fontWeight:600,color:C.textMid,marginBottom:8}}>Nog geen metingen</div>
          <div style={{marginBottom:20,fontSize:13}}>Voeg de eerste InBody-meting toe via een foto.</div>
          <button style={T.btnPrimary} onClick={onNew}>+ Meting toevoegen</button>
        </div>
      ) : (
        <>
          {/* Laatste meting met uitleg */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",...T.sectionTitle}}>
            <span>Laatste meting · {fmtDate(latest.date)}</span>
            <button style={{...T.btnGhost,color:C.red,fontSize:12}} onClick={()=>onDelete(latest.id)}>Verwijderen</button>
          </div>

          {INBODY_GROUPS.map(group => {
            const fields = INBODY_FIELDS.filter(f => f.group===group && latest.data[f.key]!=null && latest.data[f.key]!=="");
            if (!fields.length) return null;
            return (
              <div key={group} style={{marginBottom:20}}>
                <div style={{fontSize:11,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:10}}>{group}</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:10}}>
                  {fields.map(f => {
                    const val = latest.data[f.key];
                    const st = inbodyStatus(f, val, gender);
                    const isOpen = expandedInfo === f.key;
                    return (
                      <div key={f.key} style={{background:C.surface,border:`1px solid ${st?st.color+"44":C.border}`,borderRadius:10,padding:"14px 16px"}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                          <div>
                            <div style={{fontSize:11,color:C.textLow,marginBottom:3}}>{f.label}</div>
                            <div style={{fontSize:20,fontWeight:800,color:C.text,letterSpacing:"-0.02em"}}>
                              {val}<span style={{fontSize:12,color:C.textLow,fontWeight:500,marginLeft:3}}>{f.unit}</span>
                            </div>
                          </div>
                          <button style={{...T.btnGhost,fontSize:14,color:C.textLow,lineHeight:1}} onClick={()=>setExpandedInfo(isOpen?null:f.key)} title="Uitleg">ⓘ</button>
                        </div>
                        {st && <div style={{fontSize:11,fontWeight:700,color:st.color,marginTop:6}}>● {st.txt}</div>}
                        {isOpen && <div style={{fontSize:12,color:C.textMid,lineHeight:1.6,marginTop:10,paddingTop:10,borderTop:`1px solid ${C.border}`}}>{f.info}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Grafiek over tijd */}
          {measurements.length >= 2 && (
            <>
              <SectionTitle>Verloop over tijd</SectionTitle>
              <div style={{marginBottom:16}}>
                <select style={{...T.select,maxWidth:280}} value={selectedMetric} onChange={e=>setSelectedMetric(e.target.value)}>
                  {INBODY_FIELDS.filter(f=>measurements.some(m=>m.data[f.key]!=null&&m.data[f.key]!=="")).map(f=>(
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
              </div>
              {chartData.length >= 2 ? (
                <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:"20px 16px 12px",marginBottom:28}}>
                  <ResponsiveContainer width="100%" height={240}>
                    <LineChart data={chartData} margin={{top:4,right:16,left:0,bottom:4}}>
                      <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tick={{fill:C.textLow,fontSize:11}} axisLine={false} tickLine={false} />
                      <YAxis tick={{fill:C.textLow,fontSize:11}} axisLine={false} tickLine={false} width={42} domain={['auto','auto']} />
                      <Tooltip contentStyle={{background:C.surfaceHi,border:`1px solid ${C.border}`,borderRadius:8,fontSize:12,color:C.text}}
                        formatter={(v)=>[`${v} ${metricField?.unit||""}`, metricField?.label||""]} />
                      <Line type="monotone" dataKey="value" stroke={C.accent} strokeWidth={2.5} dot={{fill:C.accent,r:4,strokeWidth:0}} activeDot={{r:6}} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div style={{padding:"20px 0",color:C.textLow,fontSize:13}}>Minimaal 2 metingen met deze waarde nodig.</div>
              )}
            </>
          )}

          {/* Alle metingen lijst */}
          <SectionTitle>Alle metingen ({measurements.length})</SectionTitle>
          {measurements.map((m,i) => (
            <div key={m.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,marginBottom:8}}>
              <div>
                <span style={{fontSize:14,fontWeight:600,color:C.text}}>{fmtDate(m.date)}</span>
                <span style={{fontSize:12,color:C.textLow,marginLeft:12}}>
                  {m.data.gewicht && `${m.data.gewicht} kg`}
                  {m.data.vetpercentage && ` · ${m.data.vetpercentage}% vet`}
                  {m.data.inbodyscore && ` · score ${m.data.inbodyscore}`}
                </span>
              </div>
              {i!==0 && <button style={{...T.btnGhost,color:C.red,fontSize:12}} onClick={()=>onDelete(m.id)}>✕</button>}
            </div>
          ))}
        </>
      )}
    </>
  );
}
