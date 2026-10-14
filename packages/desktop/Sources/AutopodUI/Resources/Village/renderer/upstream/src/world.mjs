// Authored walkable waypoints. The renderer never infers paths from image pixels.
export const LOCATIONS={inn:[.86,.935],guild:[.20,.325],archive:[.83,.495],workshop:[.18,.79],checks:[.83,.79],review:[.75,.225],depot:[.49,.94],harbor:[.24,.875],noticeboard:[.065,.305],courtyard:[.29,.315],camp:[.55,.60],fishing:[.435,.69],square:[.51,.55]};
export const STATION_NAMES={inn:'Inn',guild:'Guild',archive:'Archive',workshop:'Workshop',checks:'Trial Arena',review:'Town Hall',depot:'Depot',harbor:'Harbor',noticeboard:'Guild noticeboard',courtyard:'Guild benches',camp:'Campfire',fishing:'Creek bank',square:'Town square'};
export const NODES={...LOCATIONS};
const EDGES=[];
function lane(from,to,points){let previous=from;points.forEach((p,i)=>{const key=`${from}-${to}-${i}`;NODES[key]=p;EDGES.push([previous,key]);previous=key;});EDGES.push([previous,to]);}
// Follow the crooked lanes, including the only bridge into the workshop island.
lane('depot','inn',[[.56,.95],[.64,.92],[.73,.91],[.79,.93]]);
lane('harbor','depot',[[.29,.875],[.33,.91],[.40,.94]]);
lane('noticeboard','guild',[[.13,.34],[.17,.34]]);
lane('courtyard','guild',[[.26,.35],[.23,.34]]);
lane('camp','square',[[.52,.59]]);
lane('camp','fishing',[[.51,.63],[.48,.65],[.46,.67]]);
lane('guild','square',[[.25,.34],[.30,.37],[.32,.42],[.33,.46],[.41,.48],[.46,.53]]);
lane('square','archive',[[.58,.56],[.64,.56],[.71,.55],[.78,.52]]);
lane('square','checks',[[.58,.56],[.64,.56],[.70,.56],[.68,.61],[.64,.67],[.63,.73],[.66,.78],[.75,.79]]);
lane('checks','depot',[[.75,.79],[.69,.82],[.70,.86],[.64,.92],[.56,.95]]);
lane('guild','workshop',[[.25,.34],[.30,.37],[.32,.42],[.33,.46],[.28,.47],[.17,.51],[.15,.55],[.10,.59],[.065,.64],[.065,.70],[.09,.745],[.13,.77]]);
lane('square','review',[[.46,.53],[.41,.48],[.47,.43],[.51,.35],[.57,.32],[.64,.31],[.70,.29],[.74,.26]]);
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
export function stationRoute(from,to){
  if(from===to)return [[...LOCATIONS[to]]];
  const costs=new Map([[from,0]]),prev=new Map(),todo=new Set(Object.keys(NODES));
  while(todo.size){
    const key=[...todo].sort((a,b)=>(costs.get(a)??Infinity)-(costs.get(b)??Infinity)||a.localeCompare(b))[0];
    if(key===to)break;todo.delete(key);
    for(const edge of EDGES){const next=edge[0]===key?edge[1]:edge[1]===key?edge[0]:null;if(!next||!todo.has(next))continue;
      const cost=costs.get(key)+distance(NODES[key],NODES[next]);if(cost<(costs.get(next)??Infinity)){costs.set(next,cost);prev.set(next,key);}
    }
  }
  const path=[to];while(path[0]!==from){const p=prev.get(path[0]);if(!p)throw new Error(`No village path from ${from} to ${to}`);path.unshift(p);}
  return path.map(k=>[...NODES[k]]);
}
// Authored gathering spots follow the clearings, benches and crooked lanes.
// Waiting zones and the town-square visitors deliberately use separate areas.
export const GATHERING_SPOTS={
  noticeboard:[[.055,.305],[.10,.325],[.05,.35],[.095,.375],[.145,.35],[.15,.40],[.20,.385],[.245,.405],[.20,.43],[.25,.45],[.29,.41],[.30,.46]],
  courtyard:[[.27,.29],[.31,.30],[.27,.34],[.32,.355],[.36,.32],[.36,.37],[.40,.34],[.40,.39]],
  camp:[[.48,.495],[.61,.53],[.66,.465],[.50,.655],[.57,.575],[.63,.59],[.54,.63],[.68,.57],[.62,.675],[.72,.535],[.59,.71],[.68,.65]],
  square:[[.455,.45],[.49,.425],[.44,.405],[.49,.38],[.44,.355],[.48,.325],[.44,.30],[.46,.26],[.44,.22],[.405,.19],[.39,.235],[.375,.275],[.50,.465],[.535,.435],[.57,.41],[.61,.385],[.65,.35],[.70,.32],[.74,.30],[.79,.275],[.83,.24],[.86,.21],[.85,.165],[.81,.135]],
};
export function stationSeat(station,index=0,count=1){
  const spots=GATHERING_SPOTS[station];
  if(spots&&index<spots.length)return [...spots[index]];
  const p=LOCATIONS[station],columns=Math.min(count,count>12?6:4),col=index%columns,row=Math.floor(index/columns),rows=Math.ceil(count/columns);
  const gap=Math.min(.042,.48/Math.max(1,rows-1)),top=Math.min(p[1],.97-(rows-1)*gap);
  const half=(columns-1)*.023,center=Math.max(.035+half,Math.min(.965-half,p[0]));
  return [center+(col-(columns-1)/2)*.046,top+row*gap];
}
