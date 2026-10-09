import { fail } from "@core/shared/errors.js";
import { imageModelProfiles } from "@core/modules/ai/image-model-catalog.js";
import { cropImageReferences, prepareImageEdit } from "./image-edit-adapter.js";
import { prepareSavedLocalBitmap } from "./image-saved-local-bitmap.js";
import type { RevisionRawImageCandidateV2 } from "./image-candidates.js";

/** Rebuild actual transport pixels, never substitute full source bytes for a viewport. */
export async function reconstructRevisionProviderReferences(candidate:RevisionRawImageCandidateV2,sources:{data:Buffer;mime:string;filename:string}[],crops:Parameters<typeof cropImageReferences>[2]){
  const profile=candidate.binding.mode==="local"?imageModelProfiles.find(p=>p.id===((candidate.binding.mode==="local")?candidate.binding.localFacts.provider.profileId:undefined)):undefined;
  if(candidate.binding.mode==="local"&&!profile)fail(409,"原续改模型规格已不可用，不能补造输入事实");
  const selected=await cropImageReferences(sources,candidate.references.map(x=>x.referenceImageId),crops);
  const edit=await prepareImageEdit(profile?.editMechanism??"prompt","核对持久续改输入",selected);
  if(candidate.binding.mode==="local"){
    const facts=candidate.binding.localFacts;
    const viewport=await prepareSavedLocalBitmap(sources[0]!.data,facts.region,profile!,facts.contextPaddingPixels);
    if(JSON.stringify(viewport.facts)!==JSON.stringify(facts))fail(409,"持久局部窗口事实不一致");
    return [{...selected[0]!,data:viewport.providerPNG,mime:"image/png"},...edit.images.slice(1)];
  }
  return edit.images;
}
