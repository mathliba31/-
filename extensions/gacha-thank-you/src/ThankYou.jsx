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
// 「1タップでガチャページへ飛べる、必ず表示されるボタン」という形で実現する。
//
// ガチャページのURLはコードに埋め込まず、拡張機能の設定(gacha_page_url)から取得する。
// チェックアウトエディタでブロックを配置する際にマーチャントが入力する。
export default reactExtension('purchase.thank-you.block.render', () => <GachaThankYouCta />);

function GachaThankYouCta() {
  const { gacha_page_url: gachaPageUrl } = useSettings();
  const url = typeof gachaPageUrl === 'string' ? gachaPageUrl.trim() : '';

  // URL未設定でも null を返さず必ず何かを描画する。
  // null を返すと「拡張自体が読み込まれていない」のか「設定値が空で非表示になっている」のかを
  // 画面から切り分けられなくなるため(今回の調査で実際に切り分けが困難になった箇所)。
  if (!url) {
    return <Text>ガチャページのURLが未設定です。チェックアウトエディタでこのブロックを選び、URLを入力してください。</Text>;
  }

  return (
    <BlockStack border="base" cornerRadius="base" padding="base" spacing="base" inlineAlignment="center">
      <Heading level={2}>ご購入ありがとうございます!</Heading>
      <Text>下のボタンからガチャページへ進んで、さっそく引いてみましょう。</Text>
      <Button kind="primary" to={url}>
        ガチャを回しに行く →
      </Button>
    </BlockStack>
  );
}
