import React from 'react';
import {Box, Button, Paragraph} from "grommet/es6";
import {Alert, ChatOption, Twitter, UserExpert} from "grommet-icons";
import {Link} from "./index";

export default (props) => (
    <Box gap='small' margin={{horizontal: 'small', vertical: 'medium'}} {...props}>
    <Paragraph textAlign='center'><Alert/><br/>Suite à un problème avec Twitter, l'application n'est plus disponible, mais sera de retour bientôt. Suivez <Link href='https://twitter.com/unfollowNinja'>@unfollowNinja</Link> pour plus d'infos</Paragraph>
      <Button
          icon={<Twitter color='white'/>}
          label='Connectez-vous à votre compte'
          primary={true}
          style={{color: 'white'}}
          disabled={true}
      />
      <Button
          icon={<ChatOption/>}
          label='Activez les notifications web'
          disabled={true}
      />
      <Button
          icon={<UserExpert/>}
          label={'Suivez @UnfollowNinja'}
          disabled={true}
      />
    </Box>
);