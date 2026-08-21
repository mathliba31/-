import {
  reactExtension,
  BlockStack,
  Heading,
  Text,
  Button,
  useSettings,
} from '@shopify/ui-extensions-react/checkout';

// 決済完了(Thank youページ)に、ガチャページへの導線ボタンを表示する。
// Shopifyの仕様上、決済完了ページからの完全自動リダイレクトは全マーチャント共通で
// 許可されていないため(悪用防止のためのプラットフォーム側の制約)、
// 「1タップでガチャページへ飛べる、必ず表示される大きなボタン」という形で実現する。
//
// ガチャページのURLはコードに埋め込まず、拡張機能の設定(gacha_page_url)から取得する。
// チェックアウトエディタでブロックを配置する際にマーチャントが入力する(shopify.extension.toml参照)。
export default reactExtension('purchase.thank-you.block.render', () => <GachaThankYouCta />);

function GachaThankYouCta() {
  const { gacha_page_url: gachaPageUrl } = useSettings();

  if (!gachaPageUrl || typeof gachaPageUrl !== 'string') {
    return null;
  }

  return (
    <BlockStack border="base" cornerRadius="base" padding="base" spacing="base" inlineAlignment="center">
      <Heading level={2}>ご購入ありがとうございます!</Heading>
      <Text>下のボタンからガチャページへ進んで、さっそく引いてみましょう。</Text>
      <Button kind="primary" to={gachaPageUrl}>
        ガチャを回しに行く →
      </Button>
    </BlockStack>
  );
}
