import { Stack } from "expo-router";
import { ScrollView } from "react-native";
import { MobileNavigationArea } from "../src/plugins/navigation";
import { useI18n } from "../src/locale";
export default function Extensions(){const {t}=useI18n();return <><Stack.Screen options={{title:t("navigation.more")}}/><ScrollView><MobileNavigationArea slot="mobile.more"/></ScrollView></>}
